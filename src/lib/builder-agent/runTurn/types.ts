import type {
  AgentConfigCache,
  AgentLastError,
  ContentBlock,
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

export type TurnStats = {
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
