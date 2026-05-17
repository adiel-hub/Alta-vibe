import type { ObjectId } from "mongodb";

export type KnowledgeBaseDocument = {
  id: string;
  name: string;
  type: "url" | "file" | "text";
  source: string;
};

export type RuntimeTool = {
  id: string;
  name: string;
  type: "webhook" | "client";
  description: string;
};

export type McpIntegration = {
  id: string;
  name: string;
  url: string;
};

export type AgentConfigCache = {
  name: string;
  first_message: string;
  system_prompt: string;
  voice_id: string;
  llm: string;
  temperature: number;
  knowledge_base: KnowledgeBaseDocument[];
  tools: RuntimeTool[];
  mcp_servers: McpIntegration[];
};

export type AgentLastError = {
  at: string;
  op: string;
  status: number;
  message: string;
} | null;

export type AgentDocument = {
  _id: ObjectId;
  elevenlabs_agent_id: string;
  name: string;
  description: string;
  revision: number;
  config_cache: AgentConfigCache;
  last_error: AgentLastError;
  created_at: Date;
  updated_at: Date;
};

export type AgentDTO = Omit<AgentDocument, "_id" | "created_at" | "updated_at"> & {
  id: string;
  created_at: string;
  updated_at: string;
};

// --- Anthropic content blocks (persisted verbatim in chat_messages.content)
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  output: unknown;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type ChatMessageDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  role: "user" | "assistant";
  content: ContentBlock[];
  revision_before: number;
  revision_after: number;
  created_at: Date;
};

export type ChatMessageDTO = {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  revision_before: number;
  revision_after: number;
  created_at: string;
};

// --- SSE event vocabulary (chat route → browser)
export type SSEEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call_start"; tool_use_id: string; name: string; input: unknown }
  | {
      type: "tool_call_result";
      tool_use_id: string;
      output: unknown;
      is_error?: boolean;
    }
  | {
      type: "state_patch";
      revision: number;
      patch: Partial<AgentConfigCache>;
    }
  | { type: "state_error"; section: string; message: string }
  | { type: "turn_aborted"; reason: string }
  | { type: "turn_done"; revision: number };
