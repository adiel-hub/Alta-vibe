import type {
  AgentConfigCache,
  DataCollectionField,
  EvaluationCriterion,
  KnowledgeBaseDocument,
  McpIntegration,
  PhoneNumber,
  RuntimePhase,
  RuntimeTool,
  VoiceSettings,
} from "@/types/agent";
import type { ElevenAgentRaw } from "./types";
import type { ElevenWorkflow, ElevenWorkflowNode } from "../workflow/types";
import { isLocalToolId } from "@/lib/elevenlabs/lifecycle/toolIds";

export function projectAgentConfig(
  el: ElevenAgentRaw,
  fallback: AgentConfigCache,
): AgentConfigCache {
  const a = el.conversation_config?.agent;
  const p = a?.prompt;
  const t = el.conversation_config?.tts;
  const kb: KnowledgeBaseDocument[] =
    p?.knowledge_base?.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      source: d.name,
    })) ?? fallback.knowledge_base;
  // EL is canonical for in-call tools (it owns their ids and schemas).
  // Lifecycle tools (pre/post-call) live ONLY in config_cache — EL never
  // sees them (see lifecycle/toolIds.ts) — so we always re-merge them
  // from fallback or they vanish on every projection.
  //
  // `provider` (and method/url) are local-only provenance — ElevenLabs has no
  // such field, so a naive projection strips them off in-call tools and the UI
  // loses each tool's integration logo. Re-merge them. `workflow.bindings` is
  // the authoritative source (it stores `provider` explicitly and is never
  // projected from EL), keyed by the ElevenLabs tool id; we consult it first so
  // the provider is recovered even for agents whose cached `config_cache.tools`
  // already lost it. The prior cached tool (matched by name, then id) backs that
  // up and carries method/url.
  const fallbackToolByName = new Map(fallback.tools.map((t) => [t.name, t]));
  const fallbackToolById = new Map(fallback.tools.map((t) => [t.id, t]));
  const bindingProviderByElId = new Map<string, string>();
  for (const b of fallback.workflow.bindings ?? []) {
    if (b.kind === "provider") {
      bindingProviderByElId.set(b.elevenlabs_tool_id, b.provider);
    }
  }
  const inCallTools: RuntimeTool[] = p?.tools
    ? p.tools.map((tool) => {
        const id = tool.id ?? tool.name;
        const prior =
          fallbackToolByName.get(tool.name) ?? fallbackToolById.get(id);
        const provider = bindingProviderByElId.get(id) ?? prior?.provider;
        return {
          id,
          name: tool.name,
          type: tool.type,
          description: tool.description ?? "",
          phase: phaseFor(tool.name, tool.type),
          ...(provider ? { provider } : {}),
          ...(prior?.method ? { method: prior.method } : {}),
          ...(prior?.url ? { url: prior.url } : {}),
        };
      })
    : fallback.tools.filter((t) => !isLocalToolId(t.id));
  const lifecycleTools = fallback.tools.filter((t) => isLocalToolId(t.id));
  const tools: RuntimeTool[] = [...inCallTools, ...lifecycleTools];
  const mcp: McpIntegration[] =
    p?.mcp_server_ids?.map((id) => ({ id, name: id, url: "" })) ??
    fallback.mcp_servers;
  // Labels are local-only — ElevenLabs has no label field, so on every
  // upstream read we re-merge them from the existing config_cache by id.
  // Without this, every re-projection would erase any label the agent set.
  const fallbackDataLabels = new Map(
    fallback.data_collection.map((f) => [f.id, f.label]),
  );
  const dataCollection: DataCollectionField[] = el.platform_settings?.data_collection
    ? Object.entries(el.platform_settings.data_collection).map(([name, v]) => ({
        id: name,
        name,
        type: v.type,
        description: v.description,
        ...(fallbackDataLabels.get(name)
          ? { label: fallbackDataLabels.get(name) }
          : {}),
        ...(Array.isArray(v.enum) && v.enum.length > 0
          ? { enum: v.enum }
          : {}),
      }))
    : fallback.data_collection;
  // Filter out criteria that upstream stored with a missing/empty goal prompt
  // or id. We previously coerced `prompt` to `""` here, but that's an unsafe
  // round-trip: any subsequent PATCH of evaluation_criteria (including an
  // unrelated remove_call_outcome on a SIBLING criterion) re-sends the broken
  // entry with `conversation_goal_prompt: ""`, which ElevenLabs rejects with a
  // bare "Invalid platform settings: Field required" 422. Dropping broken
  // entries at read time means our in-memory state is always serialisable —
  // tools never see them, and we never echo them back upstream.
  const rawCriteria = el.platform_settings?.evaluation?.criteria ?? null;
  // Re-merge local-only labels from the existing config by id (same reason
  // as data_collection above — upstream has no label field).
  const fallbackEvalLabels = new Map(
    fallback.evaluation_criteria.map((c) => [c.id, c.label]),
  );
  let evalCriteria: EvaluationCriterion[];
  if (rawCriteria === null) {
    evalCriteria = fallback.evaluation_criteria;
  } else {
    const accepted: EvaluationCriterion[] = [];
    for (const c of rawCriteria) {
      const prompt = c.conversation_goal_prompt ?? c.prompt ?? "";
      if (!c.id || !c.name || prompt.trim().length === 0) {
        console.warn(
          "[elevenlabs] dropping malformed evaluation criterion from agent config",
          { id: c.id, name: c.name, has_prompt: prompt.trim().length > 0 },
        );
        continue;
      }
      const preservedLabel = fallbackEvalLabels.get(c.id);
      accepted.push({
        id: c.id,
        name: c.name,
        prompt,
        ...(preservedLabel ? { label: preservedLabel } : {}),
        use_knowledge_base: c.use_knowledge_base ?? undefined,
        scope: c.scope ?? undefined,
      });
    }
    evalCriteria = accepted;
  }
  const phoneNumbers: PhoneNumber[] =
    el.phone_numbers?.map((p) => ({
      id: p.phone_number_id,
      number: p.phone_number,
      provider: p.provider,
      label: p.label,
    })) ?? fallback.phone_numbers;

  const voiceSettings: VoiceSettings = {
    stability: t?.stability ?? fallback.voice_settings.stability,
    similarity_boost: t?.similarity_boost ?? fallback.voice_settings.similarity_boost,
    style: t?.style ?? fallback.voice_settings.style,
    use_speaker_boost: t?.use_speaker_boost ?? fallback.voice_settings.use_speaker_boost,
    speed: t?.speed ?? fallback.voice_settings.speed,
  };

  return {
    name: el.name ?? fallback.name,
    first_message: a?.first_message ?? fallback.first_message,
    system_prompt: p?.prompt ?? fallback.system_prompt,
    voice_id: t?.voice_id ?? fallback.voice_id,
    voice_settings: voiceSettings,
    tts_model: t?.model_id ?? fallback.tts_model,
    language: a?.language ?? fallback.language,
    llm: p?.llm ?? fallback.llm,
    temperature: p?.temperature ?? fallback.temperature,
    max_duration_seconds:
      el.conversation_config?.conversation?.max_duration_seconds ??
      fallback.max_duration_seconds,
    knowledge_base: kb,
    tools,
    mcp_servers: mcp,
    data_collection: dataCollection,
    evaluation_criteria: evalCriteria,
    phone_numbers: phoneNumbers,
    // Workflow lives at the TOP LEVEL of the agent (not under
    // conversation_config). Keep the conversation_config path as a
    // fallback for any legacy/stub responses.
    workflow: projectWorkflow(
      (el.workflow ??
        (el.conversation_config as Record<string, unknown> | undefined)
          ?.workflow) as ElevenWorkflow | undefined,
      fallback.workflow,
    ),
  };
}

/**
 * Translate ElevenLabs' `conversation_config.workflow` back into our
 * internal WorkflowState. We can't perfectly recover the speak/collect/
 * condition distinction (all three project as `override_agent` on their
 * side), so we default to `speak` for those.
 */
function projectWorkflow(
  remote: ElevenWorkflow | undefined,
  fallback: AgentConfigCache["workflow"],
): AgentConfigCache["workflow"] {
  if (!remote || !remote.nodes) return fallback;
  const ourTypeFor = (
    t: ElevenWorkflowNode["type"],
  ): AgentConfigCache["workflow"]["nodes"][number]["type"] => {
    switch (t) {
      case "start":
        return "start";
      case "end":
        return "end";
      case "tool":
      case "dispatch_tool":
        return "tool_call";
      case "standalone_agent":
      case "agent_transfer":
      case "phone_number":
      case "transfer_to_number":
        return "transfer";
      case "say":
      case "override_agent":
      case "update_state":
      default:
        return "speak";
    }
  };
  const nodes = Object.entries(remote.nodes).map(([id, n]) => {
    const data: Record<string, unknown> = {};
    const ext = n as Record<string, unknown>;
    if (n.additional_prompt) data.prompt = n.additional_prompt;
    // Tool node: current schema is `tools: [{ tool_id }]`. Accept legacy
    // flat `tool_id` too in case an older saved agent still has it.
    const toolsArr = ext.tools as Array<{ tool_id?: string }> | undefined;
    if (toolsArr?.[0]?.tool_id) data.tool_id = toolsArr[0].tool_id;
    else if (typeof ext.tool_id === "string") data.tool_id = ext.tool_id;
    // standalone_agent: wire field is `agent_id`. Old serializer wrote
    // `target_agent_id`; fall back to that for back-compat reads.
    if (typeof ext.agent_id === "string") data.agent_id = ext.agent_id;
    else if (typeof ext.target_agent_id === "string")
      data.agent_id = ext.target_agent_id;
    if (typeof ext.delay_ms === "number") data.delay_ms = ext.delay_ms;
    if (typeof ext.transfer_message === "string")
      data.transfer_message = ext.transfer_message;
    if (typeof ext.enable_transferred_agent_first_message === "boolean")
      data.enable_transferred_agent_first_message =
        ext.enable_transferred_agent_first_message;
    // phone_number: wire field is `transfer_destination.{phone_number|sip_uri}`.
    // Re-wrap dynamic variants in {{var}} so the inspector edits the same
    // string the user typed. Accept the legacy flat `phone_number` too.
    const td = ext.transfer_destination as
      | { type?: string; phone_number?: string; sip_uri?: string }
      | undefined;
    if (td?.phone_number) {
      data.phone_number =
        td.type === "phone_dynamic_variable"
          ? `{{${td.phone_number}}}`
          : td.phone_number;
    } else if (td?.sip_uri) {
      data.phone_number =
        td.type === "sip_uri_dynamic_variable"
          ? `{{${td.sip_uri}}}`
          : td.sip_uri;
    } else if (typeof ext.phone_number === "string") {
      data.phone_number = ext.phone_number;
    }
    if (
      ext.transfer_type === "blind" ||
      ext.transfer_type === "conference" ||
      ext.transfer_type === "sip_refer"
    ) {
      data.transfer_type = ext.transfer_type;
    }
    const postDial = ext.post_dial_digits as
      | { type?: string; value?: string }
      | undefined;
    if (postDial?.value) {
      data.post_dial_digits =
        postDial.type === "dynamic"
          ? `{{${postDial.value}}}`
          : postDial.value;
    }
    const sipHeaders = ext.custom_sip_headers as
      | Array<{ type?: string; key?: string; value?: string }>
      | undefined;
    if (Array.isArray(sipHeaders)) {
      data.custom_sip_headers = sipHeaders
        .filter((h) => h.key && h.value)
        .map((h) => ({
          key: h.key as string,
          value:
            h.type === "dynamic" ? `{{${h.value}}}` : (h.value as string),
          dynamic: h.type === "dynamic",
        }));
    }
    if (Array.isArray(ext.additional_tool_ids))
      data.additional_tool_ids = ext.additional_tool_ids;
    if (Array.isArray(ext.additional_knowledge_base))
      data.additional_knowledge_base = ext.additional_knowledge_base;
    const cc = ext.conversation_config as
      | {
          tts?: { voice_id?: string };
          agent?: { prompt?: { llm?: string }; first_message?: string };
        }
      | undefined;
    if (cc) {
      data.conversation_config = cc;
      if (typeof cc.tts?.voice_id === "string")
        data.override_voice_id = cc.tts.voice_id;
      if (typeof cc.agent?.prompt?.llm === "string")
        data.override_llm = cc.agent.prompt.llm;
      if (typeof cc.agent?.first_message === "string")
        data.override_first_message = cc.agent.first_message;
    }
    return {
      id,
      type: ourTypeFor(n.type),
      label: n.label ?? id,
      data,
    };
  });
  const edges = Object.entries(remote.edges ?? {}).map(([id, e]) => {
    const fc = e.forward_condition;
    const bc = e.backward_condition;
    return {
      id,
      from: e.source,
      to: e.target,
      label: fc?.label ?? ((e as Record<string, unknown>).label as string | undefined),
      condition: fc?.type === "llm" ? fc.condition : undefined,
      forward_condition: fc,
      backward_condition: bc ?? undefined,
    };
  });
  // `bindings` is a local-only field — ElevenLabs has no concept of it,
  // so re-projection would strip it unless we explicitly carry it across
  // from the fallback (our cached state).
  return {
    nodes,
    edges,
    ...(fallback.bindings !== undefined ? { bindings: fallback.bindings } : {}),
  };
}

function phaseFor(name: string, type: string): RuntimePhase {
  const n = name.toLowerCase();
  if (n.startsWith("pre_") || n.includes("pre_call")) return "pre_call";
  if (n.startsWith("post_") || n.includes("after_call") || n.includes("post_call"))
    return "post_call";
  if (type === "system") return "in_call";
  return "in_call";
}
