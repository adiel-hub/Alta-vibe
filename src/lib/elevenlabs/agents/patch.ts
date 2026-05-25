import { deepMergeConfig } from "../patchConfig";
import { elFetch } from "../core/fetch";
import { log } from "../core/logger";
import type { AgentPatch, ElevenAgentRaw } from "./types";
import { getAgent } from "./crud";

/**
 * Whitelist of Conversational AI TTS fields. Anything our `voice_settings`
 * object carries that isn't in this list is silently dropped on patch — this
 * keeps legacy fields (`style`, `use_speaker_boost`) from polluting the wire
 * payload to the Conversational AI endpoint, which only accepts a subset of
 * the standalone TTS API's settings.
 */
const TTS_WIRE_FIELDS = new Set([
  "stability",
  "similarity_boost",
  "speed",
]);

/**
 * Pairs of fields ElevenLabs treats as mutually exclusive inside
 * `conversation_config.agent.prompt`. Sending both halves in the same PATCH
 * body produces "Cannot specify both X and Y" 422s — left side is the modern
 * reference-by-id form (the one we always want to send), right side is the
 * deprecated inline form that lingers in stored agent state.
 */
const PROMPT_CONFLICT_PAIRS: ReadonlyArray<[modern: string, deprecated: string]> = [
  ["tool_ids", "tools"],
  ["mcp_server_ids", "mcp_servers"],
  ["native_mcp_server_ids", "native_mcp_servers"],
];

/**
 * Drop deprecated halves from a prompt slice if the modern counterpart is
 * present. Defends against a future capability accidentally producing both —
 * logs + drops rather than throwing so production never gets blocked by this.
 */
function scrubPromptConflicts(promptSlice: Record<string, unknown>): void {
  for (const [modern, deprecated] of PROMPT_CONFLICT_PAIRS) {
    if (modern in promptSlice && deprecated in promptSlice) {
      log.warn("dropping deprecated prompt field to avoid conflict", {
        modern,
        deprecated,
      });
      delete promptSlice[deprecated];
    }
  }
}

export async function patchAgent(
  agentId: string,
  patch: AgentPatch,
  opts?: { branch_id?: string },
): Promise<ElevenAgentRaw> {
  const incoming: Record<string, unknown> = {};
  if (patch.name !== undefined) incoming.name = patch.name;

  // --- agent.prompt -------------------------------------------------------
  // We send ONLY the fields the caller explicitly set. ElevenLabs deep-merges
  // PATCH bodies on `conversation_config` so we don't need to echo back any
  // current state to preserve siblings. Echoing was the source of the
  // "Cannot specify both tools and tool IDs" 422s, because GET responses on
  // legacy agents echo both the deprecated inline `tools` array and the
  // modern `tool_ids`, and re-sending that pair is what ElevenLabs rejects.
  const agentSlice: Record<string, unknown> = {};
  if (patch.first_message !== undefined) agentSlice.first_message = patch.first_message;
  if (patch.language !== undefined) agentSlice.language = patch.language;
  if (patch.disable_first_message_interruptions !== undefined)
    agentSlice.disable_first_message_interruptions = patch.disable_first_message_interruptions;
  if (patch.max_conversation_duration_message !== undefined)
    agentSlice.max_conversation_duration_message = patch.max_conversation_duration_message;
  if (patch.dynamic_variables !== undefined) {
    agentSlice.dynamic_variables = {
      dynamic_variable_placeholders: patch.dynamic_variables,
    };
  }

  const promptSlice: Record<string, unknown> = {};
  if (patch.system_prompt !== undefined) promptSlice.prompt = patch.system_prompt;
  if (patch.llm !== undefined) promptSlice.llm = patch.llm;
  if (patch.temperature !== undefined) promptSlice.temperature = patch.temperature;
  if (patch.max_tokens !== undefined) promptSlice.max_tokens = patch.max_tokens;
  if (patch.reasoning_effort !== undefined)
    promptSlice.reasoning_effort = patch.reasoning_effort;
  if (patch.thinking_budget !== undefined)
    promptSlice.thinking_budget = patch.thinking_budget;
  if (patch.timezone !== undefined) promptSlice.timezone = patch.timezone;
  if (patch.knowledge_base !== undefined) promptSlice.knowledge_base = patch.knowledge_base;
  // Modern schema: reference tools / MCP servers by id, never inline. The
  // legacy `tools` / `mcp_servers` / `native_mcp_servers` arrays are
  // deprecated upstream and never sourced from our patch surface — but the
  // guard below catches them if a future caller slips one in.
  if (patch.tool_ids !== undefined) promptSlice.tool_ids = patch.tool_ids;
  if (patch.mcp_server_ids !== undefined) promptSlice.mcp_server_ids = patch.mcp_server_ids;
  if (patch.native_mcp_server_ids !== undefined)
    promptSlice.native_mcp_server_ids = patch.native_mcp_server_ids;
  scrubPromptConflicts(promptSlice);
  if (Object.keys(promptSlice).length > 0) agentSlice.prompt = promptSlice;

  // --- tts ----------------------------------------------------------------
  const ttsSlice: Record<string, unknown> = {};
  if (patch.voice_id !== undefined) ttsSlice.voice_id = patch.voice_id;
  if (patch.tts_model !== undefined) ttsSlice.model_id = patch.tts_model;
  if (patch.voice_settings) {
    for (const [k, v] of Object.entries(patch.voice_settings)) {
      if (v !== undefined && TTS_WIRE_FIELDS.has(k)) ttsSlice[k] = v;
    }
  }
  if (patch.expressive_mode !== undefined) ttsSlice.expressive_mode = patch.expressive_mode;
  if (patch.suggested_audio_tags !== undefined)
    ttsSlice.suggested_audio_tags = patch.suggested_audio_tags;
  if (patch.agent_output_audio_format !== undefined)
    ttsSlice.agent_output_audio_format = patch.agent_output_audio_format;
  if (patch.optimize_streaming_latency !== undefined)
    ttsSlice.optimize_streaming_latency = patch.optimize_streaming_latency;
  if (patch.text_normalisation_type !== undefined)
    ttsSlice.text_normalisation_type = patch.text_normalisation_type;

  // --- asr ----------------------------------------------------------------
  const asrSlice: Record<string, unknown> = {};
  if (patch.asr_quality !== undefined) asrSlice.quality = patch.asr_quality;
  if (patch.asr_provider !== undefined) asrSlice.provider = patch.asr_provider;
  if (patch.asr_keywords !== undefined) asrSlice.keywords = patch.asr_keywords;

  // --- turn ---------------------------------------------------------------
  const turnSlice: Record<string, unknown> = {};
  if (patch.turn_timeout !== undefined) turnSlice.turn_timeout = patch.turn_timeout;
  if (patch.initial_wait_time !== undefined)
    turnSlice.initial_wait_time = patch.initial_wait_time;
  if (patch.silence_end_call_timeout !== undefined)
    turnSlice.silence_end_call_timeout = patch.silence_end_call_timeout;
  if (patch.turn_eagerness !== undefined) turnSlice.turn_eagerness = patch.turn_eagerness;
  if (patch.speculative_turn !== undefined)
    turnSlice.speculative_turn = patch.speculative_turn;

  // --- conversation -------------------------------------------------------
  const conversationSlice: Record<string, unknown> = {};
  if (patch.max_duration_seconds !== undefined)
    conversationSlice.max_duration_seconds = patch.max_duration_seconds;
  if (patch.text_only !== undefined) conversationSlice.text_only = patch.text_only;
  if (patch.source_attribution !== undefined)
    conversationSlice.source_attribution = patch.source_attribution;

  const conversationConfig: Record<string, unknown> = {};
  if (Object.keys(agentSlice).length > 0) conversationConfig.agent = agentSlice;
  if (Object.keys(ttsSlice).length > 0) conversationConfig.tts = ttsSlice;
  if (Object.keys(asrSlice).length > 0) conversationConfig.asr = asrSlice;
  if (Object.keys(turnSlice).length > 0) conversationConfig.turn = turnSlice;
  if (Object.keys(conversationSlice).length > 0)
    conversationConfig.conversation = conversationSlice;
  // ElevenLabs deep-merges PATCH bodies on `conversation_config`, so we ship
  // only the slices the caller actually populated. No GET-then-echo: that's
  // exactly what re-introduced deprecated fields (`tools`, `mcp_servers`,
  // `native_mcp_servers`) from stored legacy state and triggered the
  // "Cannot specify both X and Y" 422s.
  if (Object.keys(conversationConfig).length > 0) {
    incoming.conversation_config = conversationConfig;
  }

  // --- platform_settings --------------------------------------------------
  const platformSlice: Record<string, unknown> = {};
  if (patch.data_collection !== undefined) {
    platformSlice.data_collection = patch.data_collection;
  }
  if (patch.evaluation_criteria !== undefined) {
    // Upstream expects PromptEvaluationCriteria: `conversation_goal_prompt` is
    // the required goal field; `prompt` is our internal alias.
    // Use `!= null` (not `!== undefined`) so a stray `null` from older configs
    // doesn't survive into the payload — ElevenLabs's Pydantic models type
    // these as non-nullable, so `null` triggers "Input should be a valid
    // boolean" on any PATCH that re-sends the list (e.g. remove_call_outcome
    // touching a sibling criterion with use_knowledge_base: null).
    platformSlice.evaluation = {
      criteria: patch.evaluation_criteria.map((c) => ({
        id: c.id,
        name: c.name,
        type: "prompt" as const,
        conversation_goal_prompt: c.prompt,
        ...(c.use_knowledge_base != null
          ? { use_knowledge_base: c.use_knowledge_base }
          : {}),
        ...(c.scope != null ? { scope: c.scope } : {}),
      })),
    };
  }

  // Workflow + platform_settings still need GET-then-merge because their
  // sub-fields (`workflow.prevent_subagent_loops`, `platform_settings.*`)
  // are not the same shape as the partial we build — and we don't want to
  // clobber siblings we don't manage. Fetch lazily so patches that touch
  // neither pay zero network.
  let current: ElevenAgentRaw | null = null;
  if (patch.workflow !== undefined || Object.keys(platformSlice).length > 0) {
    current = await getAgent(agentId);
  }

  // NOTE: workflow lives at the TOP LEVEL of the agent body, not under
  // `conversation_config.workflow`. Setting it under conversation_config
  // is silently ignored upstream and the real top-level `workflow` stays
  // untouched (we found this by GETting an agent and seeing the
  // populated `workflow.nodes` field outside conversation_config).
  if (patch.workflow !== undefined) {
    // Merge so we don't blow away workflow-level settings like
    // `prevent_subagent_loops` that we don't manage here. But `nodes` and
    // `edges` must be REPLACED wholesale — deep-merging them by key keeps
    // stale random ids from the prior workflow alive, which upstream
    // rejects as duplicate edges between the same `from`/`to`.
    const patchWf = patch.workflow as unknown as Record<string, unknown>;
    const merged = deepMergeConfig(
      (current?.workflow ?? {}) as Record<string, unknown>,
      patchWf,
    );
    if (patchWf.nodes !== undefined) merged.nodes = patchWf.nodes;
    if (patchWf.edges !== undefined) merged.edges = patchWf.edges;
    incoming.workflow = merged;
  }

  if (Object.keys(platformSlice).length > 0) {
    incoming.platform_settings = deepMergeConfig(
      (current?.platform_settings ?? {}) as Record<string, unknown>,
      platformSlice,
    );
  }

  // High-level summary of what we're about to send. Helps correlate a
  // single patchAgent call with the lower-level elFetch logs and the
  // upstream error body when things go wrong.
  log.info("patchAgent → PATCH /v1/convai/agents/:id", {
    agent_id: agentId,
    patch_fields: Object.keys(patch),
    body_top_keys: Object.keys(incoming),
    workflow_node_count:
      (incoming.workflow as { nodes?: Record<string, unknown> } | undefined)
        ?.nodes
        ? Object.keys(
            (incoming.workflow as { nodes: Record<string, unknown> }).nodes,
          ).length
        : undefined,
    has_tool_ids: !!(
      (incoming.conversation_config as { agent?: { prompt?: { tool_ids?: unknown } } } | undefined)
        ?.agent?.prompt?.tool_ids
    ),
    has_inline_tools: !!(
      (incoming.conversation_config as { agent?: { prompt?: { tools?: unknown } } } | undefined)
        ?.agent?.prompt?.tools
    ),
  });
  const qs = new URLSearchParams();
  if (opts?.branch_id) qs.set("branch_id", opts.branch_id);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await elFetch(`/v1/convai/agents/${agentId}${suffix}`, {
    method: "PATCH",
    section: "update",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(incoming),
  });
  const raw = (await res.json()) as ElevenAgentRaw;

  // Fire-and-forget: synthesise a title + description for this brand-new
  // upstream version so the history panel has something readable. Dynamic
  // import avoids pulling Mongo + Anthropic into the client module graph
  // until a patch actually succeeds.
  if (raw.version_id) {
    const versionId = raw.version_id;
    const patchKeys = Object.keys(patch);
    void import("@/lib/builder-agent/versionMeta")
      .then(({ recordVersionForChange }) =>
        recordVersionForChange({
          elevenlabs_agent_id: agentId,
          version_id: versionId,
          patch_keys: patchKeys,
        }),
      )
      .catch((err) => {
        log.warn("version meta hook failed to load", {
          agent_id: agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return raw;
}
