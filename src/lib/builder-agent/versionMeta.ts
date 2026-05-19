/**
 * Version metadata generator.
 *
 * ElevenLabs auto-versions every PATCH but only sets `version_description`
 * to the boilerplate "New version of your agent." — useless for a history
 * panel. This module fills the gap by summarising the last few chat
 * messages + the patch's top-level keys into a short title + description
 * via Haiku, persisted in `agent_version_meta`.
 *
 * The entry point `recordVersionForChange` is fire-and-forget: callers in
 * `patchAgent` invoke it without `await`, errors are swallowed to log,
 * and the version-history panel falls back to "Version N" if the meta
 * row hasn't landed yet.
 */
import Anthropic from "@anthropic-ai/sdk";
import { agentsCol, agentVersionMetaCol, messagesCol } from "@/lib/mongodb";
import { createLogger } from "@/lib/logger";
import type { ChatMessageDocument, ContentBlock } from "@/types/agent";

const log = createLogger("version-meta");

const TITLE_MODEL = "claude-haiku-4-5-20251001";
const TITLE_MAX_TOKENS = 200;
/**
 * How many of the most recent chat messages to feed Haiku. Picked to
 * capture the user's latest request + the assistant's mid-stream
 * narration + any tool calls it has fired so far. Keep it small so the
 * prompt stays cheap.
 */
const CHAT_CONTEXT_SIZE = 6;

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

const SYSTEM_PROMPT = `You generate short, useful titles + descriptions for changes made to a voice AI agent's configuration.

The user is shown a chronological "Version history" panel where each row needs:
  - title: 2-6 words, sentence case, no trailing period. Examples:
      "Updated voice settings"
      "Added 2 knowledge base docs"
      "Renamed agent to Sarah"
      "Connected HubSpot"
      "Rewrote system prompt"
  - description: ONE short sentence (under 120 chars), no fluff, describing what specifically changed. If the chat context doesn't make the change obvious, summarise from the patch_keys alone.

You will receive:
  1. patch_keys — the top-level config fields that were modified (e.g. ["voice_id", "voice_settings"]).
  2. Recent chat snippet — the user's last message and the assistant's narration so far (may include tool calls).

Output ONLY one JSON object on a single line, no markdown fences, no preamble:
{"title": "...", "description": "..."}

If the chat is missing or unhelpful, still produce something sensible from patch_keys alone (e.g. patch_keys=["llm","temperature"] → {"title":"Tuned LLM settings","description":"Updated the language model and temperature."}).`;

function renderChatSnippet(messages: ChatMessageDocument[]): string {
  if (messages.length === 0) return "(no recent chat — likely a panel edit)";
  return messages
    .map((m) => {
      const text = m.content
        .map((b: ContentBlock) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") {
            const input =
              typeof b.input === "object" && b.input !== null
                ? JSON.stringify(b.input).slice(0, 200)
                : String(b.input ?? "");
            return `[called ${b.name}(${input})]`;
          }
          // Tool results aren't useful for titling — skip to keep prompt tight.
          return "";
        })
        .filter(Boolean)
        .join(" ")
        .slice(0, 600);
      return `${m.role.toUpperCase()}: ${text}`;
    })
    .join("\n");
}

type GeneratedMeta = { title: string; description: string };

function parseModelOutput(raw: string): GeneratedMeta | null {
  // Haiku occasionally wraps JSON in fences despite the instruction; strip.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as { title?: unknown; description?: unknown };
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const description =
      typeof parsed.description === "string" ? parsed.description.trim() : "";
    if (!title || !description) return null;
    return {
      title: title.slice(0, 80),
      description: description.slice(0, 200),
    };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget: generate + persist version meta for a freshly-created
 * upstream version. Safe to call without `await`; failures only log.
 *
 * Idempotent: a row already present for (agent, version_id) is left alone.
 */
export async function recordVersionForChange(opts: {
  elevenlabs_agent_id: string;
  version_id: string;
  patch_keys: string[];
}): Promise<void> {
  const { elevenlabs_agent_id, version_id, patch_keys } = opts;
  const t0 = Date.now();

  try {
    const metaCol = await agentVersionMetaCol();
    // Skip if we already have meta for this version (idempotent retries).
    const existing = await metaCol.findOne({ elevenlabs_agent_id, version_id });
    if (existing) return;

    // Look up the agent doc to scope chat-message lookup.
    const agents = await agentsCol();
    const agent = await agents.findOne({ elevenlabs_agent_id });
    if (!agent) {
      log.warn("agent not found for version meta", { elevenlabs_agent_id });
      return;
    }

    const msgs = await messagesCol();
    const recent = await msgs
      .find({ agent_id: agent._id })
      .sort({ created_at: -1 })
      .limit(CHAT_CONTEXT_SIZE)
      .toArray();
    // Reverse so the user message reads first and the assistant narration last.
    recent.reverse();

    const userMsg = [
      `patch_keys: ${JSON.stringify(patch_keys)}`,
      "",
      "Recent chat:",
      renderChatSnippet(recent),
      "",
      "Produce the JSON now.",
    ].join("\n");

    const res = await client().messages.create({
      model: TITLE_MODEL,
      max_tokens: TITLE_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const parsed = parseModelOutput(text);
    if (!parsed) {
      log.warn("could not parse title model output, skipping", {
        elevenlabs_agent_id,
        version_id,
        raw_preview: text.slice(0, 200),
      });
      return;
    }

    // Upsert in case another patch in flight already wrote one — the unique
    // index on (agent, version_id) makes a plain insert race-unsafe.
    await metaCol.updateOne(
      { elevenlabs_agent_id, version_id },
      {
        $setOnInsert: {
          elevenlabs_agent_id,
          version_id,
          title: parsed.title,
          description: parsed.description,
          patch_keys,
          generated_at: new Date(),
        },
      },
      { upsert: true },
    );

    log.info("version meta generated", {
      elevenlabs_agent_id,
      version_id,
      ms: Date.now() - t0,
      title_chars: parsed.title.length,
    });
  } catch (err) {
    log.warn("version meta generation failed", {
      elevenlabs_agent_id,
      version_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
