/**
 * Core turn runner. Drives the Claude Agent SDK with the builder capability
 * tools, iterates the SDK's async generator, and forwards typed SSE events
 * via the caller-supplied emit callback. Used by the background turn-job
 * processor (`lib/turn-jobs/runner.ts`) which persists each event into
 * Mongo so any client can tail or re-tail the turn.
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createBuilderTools } from "./tools";
import { BUILDER_SYSTEM_PROMPT } from "./systemPrompt";
import { CAPABILITIES } from "@/lib/capabilities";
import { createLogger } from "@/lib/logger";
import type {
  AgentConfigCache,
  AgentLastError,
  ContentBlock,
  SSEEvent,
} from "@/types/agent";

export type RunTurnInput = {
  agentMongoId: string;
  elevenlabsAgentId: string;
  agentName: string;
  agentDescription: string;
  lastError: AgentLastError;
  currentConfig: AgentConfigCache;
  startingRevision: number;
  /** Rolling summary of turns older than the live window. */
  conversationSummary: string | null;
  /** Recent prior turns (rendered into the system prompt). Newest last. */
  transcript: Array<{ role: "user" | "assistant" | "system"; content: ContentBlock[] }>;
  userMessage: string;
  turnJobId: string;
};

export type RunTurnResult = {
  endingRevision: number;
  finalConfig: AgentConfigCache;
  assistantContent: ContentBlock[];
};

/**
 * Number of most-recent turns rendered verbatim into the prompt. Anything
 * older is folded into `conversationSummary` by the summariser. Keep in sync
 * with LIVE_WINDOW in `summarizer.ts`.
 */
const MAX_HISTORY_TURNS = 15;
const HARD_TIMEOUT_MS = 360_000;

function formatTranscript(
  transcript: RunTurnInput["transcript"],
): string {
  const recent = transcript.slice(-MAX_HISTORY_TURNS);
  if (recent.length === 0) return "(empty)";
  return recent
    .map((t) => {
      const text = t.content
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") {
            const input =
              typeof b.input === "object" && b.input !== null
                ? JSON.stringify(b.input).slice(0, 200)
                : "";
            return input ? `[called ${b.name}(${input})]` : `[called ${b.name}]`;
          }
          if (b.type === "tool_result") {
            const out =
              typeof b.output === "string"
                ? b.output.slice(0, 200)
                : JSON.stringify(b.output ?? "").slice(0, 200);
            return `[result${b.is_error ? " ERROR" : ""}: ${out}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join(" ");
      return `${t.role.toUpperCase()}: ${text}`;
    })
    .join("\n");
}

function buildSystemPrompt(input: RunTurnInput): string {
  const enabledCapabilities = CAPABILITIES.map((c) => `- ${c.id}: ${c.label}`).join("\n");
  const sections: string[] = [
    BUILDER_SYSTEM_PROMPT,
    "",
    "LOCKED AGENT CONTEXT (you can ONLY operate on this agent):",
    `  voice_agent_id: ${input.elevenlabsAgentId}`,
    `  platform_record_id: ${input.agentMongoId}`,
    `  internal_name: ${input.agentName}`,
    `  description: ${input.agentDescription || "(none)"}`,
    "  All your tools are pre-bound to this agent. You CANNOT switch to a",
    "  different agent, create another one, or read another user's data.",
    "  If the user asks for something that would require a different agent",
    '  ("can you also update my other agent…"), decline politely and stay',
    "  focused on this one.",
    "",
    "ENABLED CAPABILITIES:",
    enabledCapabilities,
    "",
    "CURRENT AGENT STATE (JSON):",
    JSON.stringify(input.currentConfig, null, 2),
  ];

  if (input.lastError) {
    sections.push(
      "",
      "LAST UPSTREAM ERROR (informational — only mention if relevant):",
      JSON.stringify(input.lastError, null, 2),
    );
  }

  if (input.conversationSummary) {
    sections.push(
      "",
      "CONVERSATION SUMMARY (older turns, condensed):",
      input.conversationSummary,
    );
  }

  sections.push(
    "",
    `RECENT CONVERSATION — last ${MAX_HISTORY_TURNS} turns, newest last:`,
    formatTranscript(input.transcript),
  );

  return sections.join("\n");
}

export async function runTurn(
  input: RunTurnInput,
  emit: (event: SSEEvent) => void,
): Promise<RunTurnResult> {
  const log = createLogger("agent-sdk", {
    agent_id: input.elevenlabsAgentId,
    turn_job_id: input.turnJobId,
  });
  log.info("session start", {
    user_msg_len: input.userMessage.length,
    transcript_turns: input.transcript.length,
    starting_revision: input.startingRevision,
  });
  let revision = input.startingRevision;
  const config: AgentConfigCache = JSON.parse(JSON.stringify(input.currentConfig));
  const assistantContent: ContentBlock[] = [];

  const tools = createBuilderTools({
    agentMongoId: input.agentMongoId,
    elevenlabs_agent_id: input.elevenlabsAgentId,
    config,
    turn_job_id: input.turnJobId,
    emit,
    bumpRevision: () => ++revision,
  });

  const allowedTools = CAPABILITIES.flatMap((c) =>
    c.tools({
      agentMongoId: input.agentMongoId,
      elevenlabs_agent_id: input.elevenlabsAgentId,
      config,
      turn_job_id: input.turnJobId,
      emit: () => {},
      bumpRevision: () => revision,
    }),
  )
    .map((t) => (t as { name?: string }).name)
    .filter((n): n is string => typeof n === "string")
    .map((n) => `mcp__alta__${n}`);

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    log.warn("hard timeout, aborting", { ms: HARD_TIMEOUT_MS });
    emit({ type: "turn_aborted", reason: `hard timeout (${HARD_TIMEOUT_MS / 1000}s)` });
    abortController.abort();
  }, HARD_TIMEOUT_MS);

  try {
    const result = query({
      prompt: input.userMessage,
      options: {
        systemPrompt: buildSystemPrompt(input),
        mcpServers: { alta: tools },
        allowedTools,
        maxTurns: 10,
        includePartialMessages: true,
        abortController,
      },
    });

    for await (const message of result) {
      forwardMessage(message, emit, assistantContent, log);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  log.info("session end", {
    ending_revision: revision,
    blocks: assistantContent.length,
  });
  emit({ type: "turn_done", revision });
  return { endingRevision: revision, finalConfig: config, assistantContent };
}

function forwardMessage(
  message: SDKMessage,
  emit: (event: SSEEvent) => void,
  assistantContent: ContentBlock[],
  log: ReturnType<typeof createLogger>,
): void {
  // partial deltas (assistant text streaming)
  if (
    message.type === "stream_event" &&
    "event" in message &&
    typeof (message as { event?: unknown }).event === "object"
  ) {
    const ev = (message as { event: { type?: string; delta?: { type?: string; text?: string } } })
      .event;
    if (
      ev?.type === "content_block_delta" &&
      ev.delta?.type === "text_delta" &&
      typeof ev.delta.text === "string"
    ) {
      emit({ type: "assistant_delta", text: ev.delta.text });
    }
    return;
  }

  if (message.type === "assistant") {
    const blocks = (message as unknown as {
      message: { content: Array<{ type: string; [k: string]: unknown }> };
    }).message.content;
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        assistantContent.push({ type: "text", text: block.text as string });
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        log.debug("tool_use", {
          name: block.name,
          tool_use_id: block.id,
        });
        assistantContent.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        });
        emit({
          type: "tool_call_start",
          tool_use_id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
    return;
  }

  if (message.type === "user") {
    const blocks = (message as unknown as {
      message: { content: Array<{ type: string; [k: string]: unknown }> };
    }).message.content;
    for (const block of blocks) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const output = block.content ?? block.output;
        const isError = block.is_error === true;
        log.debug(isError ? "tool_result error" : "tool_result", {
          tool_use_id: block.tool_use_id,
        });
        assistantContent.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          output,
          is_error: isError,
        });
        emit({
          type: "tool_call_result",
          tool_use_id: block.tool_use_id,
          output,
          is_error: isError,
        });
      }
    }
  }
}
