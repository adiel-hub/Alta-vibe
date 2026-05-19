import type { VoiceSettings } from "@/types/agent";
import type { ElevenWorkflow } from "../workflow/types";

/**
 * Version metadata returned by ElevenLabs' branch + version endpoints
 * (AgentVersionMetadata in the OpenAPI spec). `id` is the opaque
 * `agtvrsn_…` snapshot id; pass it as `?version_id=` on GET /agents/{id}
 * to fetch the historical config.
 *
 * Field names mirror upstream EXACTLY — do NOT assume `created_at` or
 * `commit_message` (those don't exist). Upstream uses
 * `time_committed_secs`, `seq_no_in_branch`, `version_description`.
 */
export type ElevenAgentVersion = {
  id: string;
  agent_id?: string;
  branch_id?: string;
  /** Unix seconds when this version was committed. */
  time_committed_secs?: number;
  /** Sequential index on the branch (e.g. version 7 of main). */
  seq_no_in_branch?: number;
  /** Upstream-generated change description for this version. */
  version_description?: string;
  parents?: unknown;
};

/**
 * A branch on an agent. Every agent has a default `main` branch; additional
 * branches must be created explicitly via POST /branches (not used by us yet).
 * Field shape mirrors `AgentBranchResponse` from the API reference.
 */
export type ElevenAgentBranch = {
  id: string;
  name: string;
  agent_id: string;
  description?: string | null;
  created_at?: number;
  last_committed_at?: number;
  is_archived?: boolean;
  protection_status?: string;
  current_live_percentage?: number;
  parent_branch_id?: string | null;
  draft_exists?: boolean;
  most_recent_versions?: ElevenAgentVersion[];
};

export type ElevenAgentRaw = {
  agent_id: string;
  /**
   * Snapshot version id of the config returned. Present on responses since
   * the Jan 2026 version-control rollout; older responses may omit it.
   */
  version_id?: string | null;
  name?: string;
  conversation_config?: {
    agent?: {
      first_message?: string;
      language?: string;
      prompt?: {
        prompt?: string;
        llm?: string;
        temperature?: number;
        knowledge_base?: Array<{
          id: string;
          name: string;
          type: "url" | "file" | "text";
        }>;
        tools?: Array<{
          id?: string;
          name: string;
          type: "webhook" | "client" | "system";
          description?: string;
          response_timeout_secs?: number;
        }>;
        mcp_server_ids?: string[];
      };
    };
    tts?: {
      voice_id?: string;
      model_id?: string;
      stability?: number;
      similarity_boost?: number;
      style?: number;
      use_speaker_boost?: boolean;
      speed?: number;
    };
    asr?: { quality?: string };
    turn?: { turn_timeout?: number };
    conversation?: { max_duration_seconds?: number };
  };
  platform_settings?: {
    data_collection?: Record<
      string,
      {
        type: "string" | "number" | "integer" | "boolean";
        description: string;
        /** Optional JSON-schema-style value constraint. */
        enum?: string[];
      }
    >;
    evaluation?: {
      criteria?: Array<{
        id: string;
        name: string;
        type?: "prompt";
        /** Upstream's source-of-truth field for the goal prompt. */
        conversation_goal_prompt?: string;
        /** Legacy alias some older configs use. */
        prompt?: string;
        use_knowledge_base?: boolean;
        scope?: "conversation" | "agent";
      }>;
    };
  };
  phone_numbers?: Array<{
    phone_number_id: string;
    phone_number: string;
    provider: string;
    label?: string;
  }>;
  /**
   * Workflow graph the runtime walks during a call. Lives at the TOP
   * LEVEL of the agent body (not under conversation_config) — putting
   * it under conversation_config is silently ignored upstream.
   */
  workflow?: {
    nodes?: Record<string, unknown>;
    edges?: Record<string, unknown>;
    prevent_subagent_loops?: boolean;
  };
};

export type AgentPatch = {
  name?: string;
  first_message?: string;
  system_prompt?: string;
  voice_id?: string;
  voice_settings?: Partial<VoiceSettings>;
  tts_model?: string;
  language?: string;
  llm?: string;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: "low" | "medium" | "high";
  thinking_budget?: number;
  timezone?: string;
  disable_first_message_interruptions?: boolean;
  max_conversation_duration_message?: string;
  dynamic_variables?: Record<string, string>;
  max_duration_seconds?: number;
  text_only?: boolean;
  source_attribution?: boolean;
  knowledge_base?: Array<{
    id: string;
    name: string;
    type: "url" | "file" | "text";
  }>;
  /** Preferred way to attach tools: pass workspace tool ids. */
  tool_ids?: string[];
  mcp_server_ids?: string[];
  native_mcp_server_ids?: string[];
  data_collection?: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean";
      description: string;
      enum?: string[];
    }
  >;
  evaluation_criteria?: Array<{
    id: string;
    name: string;
    prompt: string;
    use_knowledge_base?: boolean;
    scope?: "conversation" | "agent";
  }>;
  // ASR
  asr_quality?: "high" | "low";
  asr_provider?: "elevenlabs" | "deepgram";
  asr_keywords?: string[];
  // Turn detection
  turn_timeout?: number;
  initial_wait_time?: number;
  silence_end_call_timeout?: number;
  turn_eagerness?: "low" | "standard" | "high";
  speculative_turn?: boolean;
  // v3 expressive
  expressive_mode?: boolean;
  suggested_audio_tags?: string[];
  agent_output_audio_format?: string;
  optimize_streaming_latency?: number;
  text_normalisation_type?: "system_prompt" | "elevenlabs" | "off";
  /**
   * Structured workflow graph stored at conversation_config.workflow.
   * Object-keyed maps (not arrays) per the ElevenAgents schema:
   *   nodes: { [id]: { type, label?, additional_prompt?, edge_order: string[], ... } }
   *   edges: { [id]: { source, target, forward_condition: { type, condition? } } }
   *
   * When set, the agent's runtime follows the graph itself — no need to
   * inline the workflow as text in the system prompt.
   */
  workflow?: ElevenWorkflow;
};
