/**
 * The single source of truth for what the builder agent can do.
 *
 * Add a new feature = add the capability module here. The builder MCP server,
 * the default agent config, and the right-panel section keys all derive from
 * this list — there is nowhere else to touch.
 */
import type { AgentConfigCache } from "@/types/agent";
import type { Capability } from "./types";

import { identityCapability } from "./identity/identity";
import { introspectionCapability } from "./meta/introspection";
import { voiceCapability } from "./voice/voice";
import { llmCapability } from "./intelligence/llm";
import { knowledgeBaseCapability } from "./intelligence/knowledge_base";
import { runtimeToolsCapability } from "./tools/runtime_tools";
import { writeToolCapability } from "./tools/write_tool";
import { mcpCapability } from "./tools/mcp";
import { postCallAnalysisCapability } from "./analysis/post_call_analysis";
import { telephonyCapability } from "./telephony/telephony";
import { workflowCapability } from "./experience/workflow";
import { widgetsCapability } from "./experience/widgets";
import { integrationsCapability } from "./tools/integrations";
import { turnDetectionCapability } from "./voice/turn_detection";
import { asrCapability } from "./voice/asr";
import { conversationFlowCapability } from "./intelligence/conversation_flow";
import { batchCallingCapability } from "./telephony/batch_calling";
import { workspaceSecretsCapability } from "./security/workspace_secrets";

export const CAPABILITIES: Capability[] = [
  introspectionCapability,
  identityCapability,
  voiceCapability,
  llmCapability,
  knowledgeBaseCapability,
  runtimeToolsCapability,
  writeToolCapability,
  mcpCapability,
  postCallAnalysisCapability,
  telephonyCapability,
  workflowCapability,
  widgetsCapability,
  integrationsCapability,
  turnDetectionCapability,
  asrCapability,
  conversationFlowCapability,
  batchCallingCapability,
  workspaceSecretsCapability,
];

/** Build the initial config_cache by merging every capability's default slice. */
export function defaultAgentConfig(): AgentConfigCache {
  const base: AgentConfigCache = {
    name: "Untitled voice agent",
    first_message: "Hi! How can I help today?",
    system_prompt: "You are a helpful voice agent.",
    voice_id: "",
    voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1 },
    tts_model: "eleven_v3_conversational",
    language: "en",
    llm: "gemini-2.0-flash",
    temperature: 0.5,
    max_duration_seconds: 600,
    knowledge_base: [],
    tools: [],
    mcp_servers: [],
    data_collection: [],
    evaluation_criteria: [],
    phone_numbers: [],
    workflow: { nodes: [{ id: "start", type: "start", label: "Call connects", data: {} }], edges: [] },
    integrations: [],
  };
  for (const cap of CAPABILITIES) {
    Object.assign(base, cap.defaultSlice());
  }
  return base;
}

export type { Capability, ToolContext } from "./types";
export { runToolStep } from "./types";
