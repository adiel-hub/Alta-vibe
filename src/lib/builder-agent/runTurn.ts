/**
 * Core turn runner. Calls the Claude Agent SDK with the builder MCP tools,
 * iterates the SDK's async-generator stream, and pushes typed SSE events into
 * the caller-supplied emit callback. Used by both the in-process path
 * (Vercel Function direct invocation, local dev) and — via the JSONL-over-
 * stdio entrypoint — by the Vercel Sandbox path.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createBuilderTools, BUILDER_TOOL_NAMES } from "./tools";
import { BUILDER_SYSTEM_PROMPT } from "./systemPrompt";
import type {
  AgentConfigCache,
  ContentBlock,
  SSEEvent,
} from "@/types/agent";

export type RunTurnInput = {
  elevenlabsAgentId: string;
  currentConfig: AgentConfigCache;
  startingRevision: number;
  /** Recent prior turns (rendered into the system prompt). Newest last. */
  transcript: Array<{ role: "user" | "assistant"; content: ContentBlock[] }>;
  userMessage: string;
};

export type RunTurnResult = {
  endingRevision: number;
  /** Final config snapshot after all successful tool calls. */
  finalConfig: AgentConfigCache;
  /** Assistant content blocks (text + tool_use + tool_result) to persist. */
  assistantContent: ContentBlock[];
};

const MAX_HISTORY_TURNS = 6;
const HARD_TIMEOUT_MS = 90_000;

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
          if (b.type === "tool_use") return `[called ${b.name}]`;
          if (b.type === "tool_result")
            return `[result${b.is_error ? " ERROR" : ""}]`;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      return `${t.role.toUpperCase()}: ${text}`;
    })
    .join("\n");
}

function buildSystemPrompt(input: RunTurnInput): string {
  return [
    BUILDER_SYSTEM_PROMPT,
    "",
    "CURRENT AGENT STATE (JSON):",
    JSON.stringify(input.currentConfig, null, 2),
    "",
    "RECENT CONVERSATION (newest last):",
    formatTranscript(input.transcript),
  ].join("\n");
}

export async function runTurn(
  input: RunTurnInput,
  emit: (event: SSEEvent) => void,
): Promise<RunTurnResult> {
  let revision = input.startingRevision;
  const config: AgentConfigCache = JSON.parse(JSON.stringify(input.currentConfig));
  const assistantContent: ContentBlock[] = [];

  const tools = createBuilderTools({
    elevenlabs_agent_id: input.elevenlabsAgentId,
    config,
    emit,
    bumpRevision: () => ++revision,
  });

  const allowedTools = BUILDER_TOOL_NAMES.map((n) => `mcp__alta__${n}`);

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    emit({ type: "turn_aborted", reason: "hard timeout (90s)" });
    abortController.abort();
  }, HARD_TIMEOUT_MS);

  try {
    const result = query({
      prompt: input.userMessage,
      options: {
        systemPrompt: buildSystemPrompt(input),
        mcpServers: { alta: tools },
        allowedTools,
        maxTurns: 8,
        includePartialMessages: true,
        abortController,
      },
    });

    for await (const message of result) {
      forwardMessage(message, emit, assistantContent);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  emit({ type: "turn_done", revision });
  return { endingRevision: revision, finalConfig: config, assistantContent };
}

function forwardMessage(
  message: SDKMessage,
  emit: (event: SSEEvent) => void,
  assistantContent: ContentBlock[],
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
        // Final accumulated text — persist (deltas already emitted)
        assistantContent.push({ type: "text", text: block.text as string });
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
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
