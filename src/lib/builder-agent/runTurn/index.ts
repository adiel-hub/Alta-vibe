/**
 * Core turn runner. Drives the Claude Agent SDK with the builder capability
 * tools, iterates the SDK's async generator, and forwards typed SSE events
 * via the caller-supplied emit callback. Used by the background turn-job
 * processor (`lib/turn-jobs/runner.ts`) which persists each event into
 * Mongo so any client can tail or re-tail the turn.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createBuilderTools } from "../tools";
import { createLogger } from "@/lib/logger";
import type {
  AgentConfigCache,
  ContentBlock,
  SSEEvent,
} from "@/types/agent";
import { HARD_TIMEOUT_MS } from "./constants";
import { buildSystemPrompt } from "./prompt/buildSystemPrompt";
import { forwardMessage } from "./forward";
import type { RunTurnInput, RunTurnResult, TurnStats } from "./types";

export type { RunTurnInput, RunTurnResult } from "./types";

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
