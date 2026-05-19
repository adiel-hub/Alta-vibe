// Barrel re-export. The implementation was split into per-domain modules
// under ./core, ./agents, ./workflow, ./voices, ./models, ./knowledge-base,
// ./batch-calling, ./secrets, ./simulation, ./runtime-tools, ./phone-numbers,
// ./conversations. This file preserves the original `@/lib/elevenlabs/client`
// import path so all existing call-sites keep working.

// --- Core -------------------------------------------------------------------
export { ElevenLabsError } from "./core/errors";

// --- Voices -----------------------------------------------------------------
export { listVoices } from "./voices";
export type { ElevenVoice } from "./voices";

// --- Models -----------------------------------------------------------------
export { listTtsModels } from "./models";
export type { TTSModel } from "./models";

// --- Agents -----------------------------------------------------------------
export type {
  AgentPatch,
  ElevenAgentBranch,
  ElevenAgentRaw,
  ElevenAgentVersion,
} from "./agents/types";
export { createAgent, deleteAgent, getAgent } from "./agents/crud";
export {
  getAgentAtVersion,
  getAgentBranch,
  listAgentBranches,
  listAgentVersions,
} from "./agents/branches";
export { patchAgent } from "./agents/patch";
export { projectAgentConfig } from "./agents/project";

// --- Workflow ---------------------------------------------------------------
export type {
  ElevenForwardCondition,
  ElevenWorkflow,
  ElevenWorkflowEdge,
  ElevenWorkflowNode,
} from "./workflow/types";

// --- Knowledge base ---------------------------------------------------------
export type { ElevenKbDoc } from "./knowledge-base";
export {
  createKbFromFile,
  createKbFromText,
  createKbFromUrl,
  deleteKbDocument,
  getKbDependentAgents,
  getKbDocumentContent,
  ragIndexKbDocument,
  refreshKbDocument,
  renameKbDocument,
  searchKnowledgeBase,
} from "./knowledge-base";

// --- Batch calling ----------------------------------------------------------
export type { BatchCallRecipient } from "./batch-calling";
export {
  cancelBatchCall,
  getBatchCall,
  submitBatchCall,
} from "./batch-calling";

// --- Workspace secrets ------------------------------------------------------
export {
  createWorkspaceSecret,
  listWorkspaceSecrets,
} from "./secrets";

// --- Agent simulation -------------------------------------------------------
export { simulateConversation } from "./simulation";

// --- Runtime tools ----------------------------------------------------------
export type { RuntimeToolSpec } from "./runtime-tools";
export {
  createRuntimeTool,
  deleteRuntimeTool,
} from "./runtime-tools";

// --- Phone numbers ----------------------------------------------------------
export type {
  ImportSIPTrunkPhoneNumberInput,
  ImportTwilioPhoneNumberInput,
  InboundSIPTrunkConfig,
  OutboundSIPTrunkConfig,
  SIPMediaEncryption,
  SIPTransport,
  SIPTrunkCredentials,
  TwilioEdgeLocation,
  TwilioRegionId,
  UpdatePhoneNumberInput,
  WorkspacePhoneNumber,
} from "./phone-numbers/types";
export {
  assignPhoneNumberToAgent,
  listPhoneNumbers,
  listPhoneNumbersForAgent,
} from "./phone-numbers/workspace";
export {
  importSIPTrunkPhoneNumber,
  importTwilioPhoneNumber,
} from "./phone-numbers/import";
export {
  deletePhoneNumber,
  getPhoneNumber,
  getPhoneNumberSipMessages,
  updatePhoneNumber,
} from "./phone-numbers/crud";
export { initiateOutboundCall } from "./phone-numbers/outbound";

// --- Conversations (call logs) ----------------------------------------------
export { getConversationSignedUrl } from "./conversations/signed-url";
export { listConversations } from "./conversations/list";
export { getConversationDetail } from "./conversations/detail";
export { fetchConversationAudio } from "./conversations/audio";
