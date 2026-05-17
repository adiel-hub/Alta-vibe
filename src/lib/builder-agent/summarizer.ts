/**
 * Rolling conversation summariser. Keeps the live transcript window small
 * (LIVE_WINDOW turns) and folds anything older into a single text summary
 * persisted on the agent document. Runs in the background turn pipeline
 * before the main agent loop; the summary is rendered into the system prompt
 * so the agent never loses context as the chat grows.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ObjectId } from "mongodb";
import { agentsCol } from "@/lib/mongodb";
import { createLogger } from "@/lib/logger";
import type { ChatMessageDocument, ContentBlock } from "@/types/agent";

export const LIVE_WINDOW = 15;
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const SUMMARY_MAX_TOKENS = 800;

const log = createLogger("summarizer");

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedClient;
}

function renderForSummary(messages: ChatMessageDocument[]): string {
  return messages
    .map((m) => {
      const text = m.content
        .map((b: ContentBlock) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") {
            const input =
              typeof b.input === "object" && b.input !== null
                ? JSON.stringify(b.input).slice(0, 240)
                : String(b.input ?? "");
            return `[called ${b.name}(${input})]`;
          }
          if (b.type === "tool_result") {
            const out =
              typeof b.output === "string"
                ? b.output.slice(0, 240)
                : JSON.stringify(b.output ?? "").slice(0, 240);
            return `[result${b.is_error ? " ERROR" : ""}: ${out}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join(" ");
      return `${m.role.toUpperCase()}: ${text}`;
    })
    .join("\n");
}

const SYSTEM = `You maintain a rolling summary of a builder-conversation between a USER and an ASSISTANT that is configuring a voice agent. The ASSISTANT calls tools to mutate the voice agent's config (voice, system prompt, workflow, tools, knowledge base, integrations, telephony, etc).

Produce a compact running summary that preserves:
- Decisions the user has made (voice picked, language, persona, etc.)
- Outstanding requests or TODOs the user has stated
- Things the user has explicitly said NOT to do
- Names, identifiers, and concrete values referenced
- The shape of the workflow / tools the user is building

Be terse and factual. Omit small talk, restate decisions only once. Target 200-400 words. Output ONLY the new summary text — no preamble, no markdown headings.`;

/**
 * Returns true if a summary update was performed.
 *
 * Loads messages from `messages` that are older than the live window and not
 * yet covered by the agent's stored summary, folds them in, and persists.
 */
export async function maybeUpdateConversationSummary(
  agentId: ObjectId,
  allPriorMessages: ChatMessageDocument[],
  existingSummary: string | null,
  summaryThroughId: ObjectId | null,
): Promise<{ summary: string | null; throughId: ObjectId | null }> {
  if (allPriorMessages.length <= LIVE_WINDOW) {
    return { summary: existingSummary, throughId: summaryThroughId };
  }

  const liveBoundaryIdx = allPriorMessages.length - LIVE_WINDOW;
  const candidates = allPriorMessages.slice(0, liveBoundaryIdx);

  let newlyFalling = candidates;
  if (summaryThroughId) {
    const cutoffIdx = candidates.findIndex((m) => m._id.equals(summaryThroughId));
    newlyFalling = cutoffIdx === -1 ? candidates : candidates.slice(cutoffIdx + 1);
  }

  if (newlyFalling.length === 0) {
    return { summary: existingSummary, throughId: summaryThroughId };
  }

  const t0 = Date.now();
  try {
    const previous = existingSummary ?? "(no prior summary)";
    const newText = renderForSummary(newlyFalling);
    const userMsg = [
      "PRIOR SUMMARY:",
      previous,
      "",
      "NEW MESSAGES TO FOLD IN (chronological):",
      newText,
      "",
      "Produce the updated rolling summary now.",
    ].join("\n");

    const res = await client().messages.create({
      model: SUMMARY_MODEL,
      max_tokens: SUMMARY_MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: userMsg }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      log.warn("empty summary returned, keeping previous", {
        agent_id: agentId.toHexString(),
      });
      return { summary: existingSummary, throughId: summaryThroughId };
    }

    const newThroughId = newlyFalling[newlyFalling.length - 1]._id;
    const col = await agentsCol();
    await col.updateOne(
      { _id: agentId },
      {
        $set: {
          conversation_summary: text,
          summary_through_message_id: newThroughId,
        },
      },
    );

    log.info("summary updated", {
      agent_id: agentId.toHexString(),
      ms: Date.now() - t0,
      folded_in: newlyFalling.length,
      summary_chars: text.length,
    });

    return { summary: text, throughId: newThroughId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    log.error("summary update failed; continuing without refresh", {
      agent_id: agentId.toHexString(),
      message,
    });
    return { summary: existingSummary, throughId: summaryThroughId };
  }
}
