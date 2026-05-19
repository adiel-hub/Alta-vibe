/**
 * Core turn runner. Drives the Claude Agent SDK with the builder capability
 * tools, iterates the SDK's async generator, and forwards typed SSE events
 * via the caller-supplied emit callback. Used by the background turn-job
 * processor (`lib/turn-jobs/runner.ts`) which persists each event into
 * Mongo so any client can tail or re-tail the turn.
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createBuilderTools } from "./tools";
import {
  BUILDER_FIRST_TURN_ADDENDUM,
  BUILDER_SYSTEM_PROMPT,
} from "./systemPrompt";
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
  // True only for the very first user message after agent creation. Once
  // any turn has happened the transcript carries it (or, after enough
  // turns, conversationSummary does). We use this to skip the long
  // FIRST-TURN BUILD FLOW addendum on every subsequent turn — it would
  // otherwise burn tokens on guidance the agent has already executed.
  const isFirstTurn =
    input.transcript.length === 0 && !input.conversationSummary;
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

  if (isFirstTurn) {
    sections.push("", BUILDER_FIRST_TURN_ADDENDUM);
  }

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

  const { server: tools, allowedToolNames: allowedTools } = createBuilderTools({
    agentMongoId: input.agentMongoId,
    elevenlabs_agent_id: input.elevenlabsAgentId,
    config,
    turn_job_id: input.turnJobId,
    emit,
    bumpRevision: () => ++revision,
  });

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    log.warn("hard timeout, aborting", { ms: HARD_TIMEOUT_MS });
    emit({ type: "turn_aborted", reason: `hard timeout (${HARD_TIMEOUT_MS / 1000}s)` });
    abortController.abort();
  }, HARD_TIMEOUT_MS);

  // Running totals updated by forwardMessage so we can emit a single
  // line at session end summarising the whole turn.
  const stats: TurnStats = {
    sdk_messages: 0,
    text_chars: 0,
    thinking_chars: 0,
    tool_calls: 0,
    tool_results: 0,
    stream_deltas: 0,
    model_turns: 0,
    last_stop_reason: null,
    usage: null,
    cost_usd: 0,
    api_ms: 0,
  };

  // Whitelist of tool names the builder agent is allowed to invoke. Anything
  // else — Bash, Read, Edit, Task, AskUserQuestion, Skill, etc. — is denied
  // by `canUseTool` below. We tried `tools: []` + `disallowedTools` first;
  // both are silently ignored in this SDK version (the underlying Claude
  // Code CLI keeps re-injecting the `claude_code` preset). canUseTool is
  // the only knob that runs in OUR process and is therefore authoritative.
  const allowedToolSet = new Set(allowedTools);

  try {
    const result = query({
      prompt: input.userMessage,
      options: {
        model: "claude-opus-4-7",
        systemPrompt: buildSystemPrompt(input),
        mcpServers: { alta: tools },
        allowedTools,
        // Belt-and-braces: ask the SDK to disable built-ins. The CLI ignores
        // both in 0.3.143 — see canUseTool below for the actual enforcement.
        tools: [],
        disallowedTools: ["AskUserQuestion"],
        canUseTool: async (toolName, input) => {
          if (allowedToolSet.has(toolName)) {
            return { behavior: "allow", updatedInput: input };
          }
          log.warn("blocked tool call", { tool: toolName });
          return {
            behavior: "deny",
            message: `Tool "${toolName}" is not available on this agent. Use one of the mcp__alta__* tools — for multi-choice user prompts call mcp__alta__request_user_action with kind="pick_option" instead of AskUserQuestion.`,
          };
        },
        maxTurns: 50,
        includePartialMessages: true,
        // Surface the model's chain-of-thought as `thinking` blocks so
        // we can log it server-side. Adaptive lets the model decide how
        // much to think per turn (default on Opus 4.7); we log whatever
        // it emits.
        thinking: { type: "adaptive" },
        abortController,
      },
    });

    log.info("query started", {
      model: "claude-opus-4-7",
      allowed_tool_count: allowedTools.length,
      max_turns: 50,
      thinking: "adaptive",
    });

    for await (const message of result) {
      forwardMessage(message, emit, assistantContent, log, stats);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  log.info("session end", {
    ending_revision: revision,
    blocks: assistantContent.length,
    sdk_messages: stats.sdk_messages,
    model_turns: stats.model_turns,
    tool_calls: stats.tool_calls,
    tool_results: stats.tool_results,
    stream_deltas: stats.stream_deltas,
    text_chars: stats.text_chars,
    thinking_chars: stats.thinking_chars,
    stop_reason: stats.last_stop_reason,
    cost_usd: stats.cost_usd > 0 ? Math.round(stats.cost_usd * 1000) / 1000 : undefined,
    api_ms: stats.api_ms || undefined,
    usage: stats.usage ?? undefined,
  });
  emit({ type: "turn_done", revision });
  return { endingRevision: revision, finalConfig: config, assistantContent };
}

type TurnStats = {
  sdk_messages: number;
  text_chars: number;
  thinking_chars: number;
  tool_calls: number;
  tool_results: number;
  stream_deltas: number;
  model_turns: number;
  last_stop_reason: string | null;
  usage: Record<string, unknown> | null;
  cost_usd: number;
  api_ms: number;
};

/** Cap a string so logs stay scannable. Set LOG_AGENT_FULL=1 to disable. */
const FULL_LOG_DUMP = process.env.LOG_AGENT_FULL === "1";
function truncate(s: string, max = 400): string {
  if (FULL_LOG_DUMP) return s;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}
function summariseInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    return truncate(JSON.stringify(input));
  } catch {
    return "[unserialisable input]";
  }
}

function forwardMessage(
  message: SDKMessage,
  emit: (event: SSEEvent) => void,
  assistantContent: ContentBlock[],
  log: ReturnType<typeof createLogger>,
  stats: TurnStats,
): void {
  stats.sdk_messages++;

  // ── stream_event: partial deltas (text + thinking + tool_input) ───────
  if (message.type === "stream_event") {
    const ev = (
      message as unknown as {
        event?: {
          type?: string;
          index?: number;
          content_block?: { type?: string; name?: string; id?: string };
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            partial_json?: string;
            signature?: string;
            stop_reason?: string;
          };
          message?: { stop_reason?: string };
        };
      }
    ).event;
    if (!ev || typeof ev !== "object") return;

    stats.stream_deltas++;

    if (ev.type === "content_block_start") {
      const cb = ev.content_block;
      if (cb?.type === "thinking") {
        log.info("model thinking start", { index: ev.index });
      } else if (cb?.type === "tool_use") {
        log.debug("tool_use block start", {
          index: ev.index,
          name: cb.name,
          tool_use_id: cb.id,
        });
      } else if (cb?.type === "text") {
        log.debug("text block start", { index: ev.index });
      }
      return;
    }

    if (ev.type === "content_block_delta") {
      const d = ev.delta;
      if (d?.type === "text_delta" && typeof d.text === "string") {
        stats.text_chars += d.text.length;
        emit({ type: "assistant_delta", text: d.text });
        return;
      }
      if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
        // The model's chain-of-thought, streamed token-by-token. Log at
        // info level so it shows up by default; the user explicitly
        // asked to see the reasoning. Backend-only: not forwarded to
        // the client via SSE.
        stats.thinking_chars += d.thinking.length;
        log.info("thinking", { delta: truncate(d.thinking, 200) });
        return;
      }
      if (d?.type === "signature_delta") {
        log.debug("thinking signature delta");
        return;
      }
      if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
        log.debug("tool_input delta", {
          delta: truncate(d.partial_json, 120),
        });
        return;
      }
      // Unknown delta kind — surface so we notice when the SDK adds new ones.
      log.debug("stream delta (unknown kind)", { delta_type: d?.type });
      return;
    }

    if (ev.type === "content_block_stop") {
      log.debug("content_block_stop", { index: ev.index });
      return;
    }

    if (ev.type === "message_start") {
      log.debug("message_start");
      return;
    }

    if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) {
        stats.last_stop_reason = ev.delta.stop_reason;
        log.debug("message_delta", { stop_reason: ev.delta.stop_reason });
      }
      return;
    }

    if (ev.type === "message_stop") {
      log.debug("message_stop");
      return;
    }

    log.debug("stream_event (unhandled)", { event_type: ev.type });
    return;
  }

  // ── assistant: full content array for a completed model turn ─────────
  if (message.type === "assistant") {
    stats.model_turns++;
    const am = message as unknown as {
      message: {
        content: Array<{ type: string; [k: string]: unknown }>;
        stop_reason?: string;
        usage?: Record<string, unknown>;
      };
      parent_tool_use_id?: string | null;
      uuid?: string;
      subagent_type?: string;
    };
    const blocks = am.message.content;
    log.info("assistant message", {
      blocks: blocks.length,
      types: blocks.map((b) => b.type),
      stop_reason: am.message.stop_reason,
      subagent: am.subagent_type,
      parent_tool_use_id: am.parent_tool_use_id ?? undefined,
    });
    if (am.message.stop_reason) stats.last_stop_reason = am.message.stop_reason;

    for (const block of blocks) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        // Log the FULL thinking text once the block is complete. This
        // is the most useful form for debugging — you see the entire
        // chain-of-thought without scrolling through individual deltas.
        log.info("model thinking (complete)", {
          chars: (block.thinking as string).length,
          text: truncate(block.thinking as string, 2000),
        });
      } else if (block.type === "redacted_thinking") {
        log.info("model thinking (redacted)", {
          note: "Anthropic redacted this thinking block for safety reasons.",
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        const text = block.text as string;
        log.info("model text", { chars: text.length, text: truncate(text, 500) });
        assistantContent.push({ type: "text", text });
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        stats.tool_calls++;
        log.info("model tool_use", {
          name: block.name,
          tool_use_id: block.id,
          input: summariseInput(block.input),
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
      } else {
        log.warn("assistant block (unhandled)", { block_type: block.type });
      }
    }
    return;
  }

  // ── user: tool results coming back from the SDK ──────────────────────
  if (message.type === "user") {
    const um = message as unknown as {
      message: { content: Array<{ type: string; [k: string]: unknown }> };
      parent_tool_use_id?: string | null;
    };
    const blocks = um.message.content;
    for (const block of blocks) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const output = block.content ?? block.output;
        const isError = block.is_error === true;
        stats.tool_results++;
        log.info(isError ? "tool_result (error)" : "tool_result", {
          tool_use_id: block.tool_use_id,
          output: summariseInput(output),
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
      } else {
        log.debug("user block (unhandled)", { block_type: block.type });
      }
    }
    return;
  }

  // ── system: lifecycle / housekeeping events from the SDK ─────────────
  if (message.type === "system") {
    const sm = message as unknown as {
      subtype?: string;
      [k: string]: unknown;
    };
    log.info("sdk system", {
      subtype: sm.subtype,
      payload: truncate(JSON.stringify(sm), 400),
    });
    return;
  }

  // ── result: final session result with usage + cost ────────────────────
  if (message.type === "result") {
    const rm = message as unknown as {
      subtype?: string;
      duration_ms?: number;
      duration_api_ms?: number;
      num_turns?: number;
      stop_reason?: string | null;
      total_cost_usd?: number;
      usage?: Record<string, unknown>;
      is_error?: boolean;
    };
    if (typeof rm.duration_api_ms === "number") stats.api_ms = rm.duration_api_ms;
    if (typeof rm.total_cost_usd === "number") stats.cost_usd = rm.total_cost_usd;
    if (rm.usage) stats.usage = rm.usage;
    if (rm.stop_reason) stats.last_stop_reason = rm.stop_reason;
    log.info("sdk result", {
      subtype: rm.subtype,
      is_error: rm.is_error,
      num_turns: rm.num_turns,
      duration_ms: rm.duration_ms,
      duration_api_ms: rm.duration_api_ms,
      stop_reason: rm.stop_reason,
      total_cost_usd: rm.total_cost_usd,
      usage: rm.usage,
    });
    return;
  }

  // Everything else (auth_status, rate_limit_event, plugin_install, …).
  log.info("sdk message (other)", {
    type: (message as { type?: string }).type,
  });
}
