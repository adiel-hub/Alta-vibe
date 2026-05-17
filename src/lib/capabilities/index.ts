/**
 * The single source of truth for what the builder agent can do.
 *
 * Add a new feature = add the capability module here. The builder MCP server,
 * the default agent config, and the right-panel section keys all derive from
 * this list — there is nowhere else to touch.
 */
import type { AgentConfigCache } from "@/types/agent";
import type { Capability } from "./types";

import { identityCapability } from "./identity";
import { voiceCapability } from "./voice";
import { llmCapability } from "./llm";
import { knowledgeBaseCapability } from "./knowledge_base";
import { runtimeToolsCapability } from "./runtime_tools";
import { mcpCapability } from "./mcp";
import { postCallAnalysisCapability } from "./post_call_analysis";
import { telephonyCapability } from "./telephony";
import { workflowCapability } from "./workflow";
import { workflowTrackingCapability } from "./workflow_tracking";
import { widgetsCapability } from "./widgets";
import { integrationsCapability } from "./integrations";
import { turnDetectionCapability } from "./turn_detection";
import { asrCapability } from "./asr";
import { conversationFlowCapability } from "./conversation_flow";
import { batchCallingCapability } from "./batch_calling";
import { workspaceSecretsCapability } from "./workspace_secrets";

export const CAPABILITIES: Capability[] = [
  identityCapability,
  voiceCapability,
  llmCapability,
  knowledgeBaseCapability,
  runtimeToolsCapability,
  mcpCapability,
  postCallAnalysisCapability,
  telephonyCapability,
  workflowCapability,
  workflowTrackingCapability,
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
    tts_model: "eleven_turbo_v2_5",
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
