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
  const tools: RuntimeTool[] =
    p?.tools?.map((tool) => ({
      id: tool.id ?? tool.name,
      name: tool.name,
      type: tool.type,
      description: tool.description ?? "",
      phase: phaseFor(tool.name, tool.type),
    })) ?? fallback.tools;
  const mcp: McpIntegration[] =
    p?.mcp_server_ids?.map((id) => ({ id, name: id, url: "" })) ??
    fallback.mcp_servers;
  const dataCollection: DataCollectionField[] = el.platform_settings?.data_collection
    ? Object.entries(el.platform_settings.data_collection).map(([name, v]) => ({
        id: name,
        name,
        type: v.type,
        description: v.description,
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
      // Coerce nullish flags to undefined so they never round-trip back into a
      // PATCH payload as `null`. Upstream's PromptEvaluationCriteria types
      // these as non-nullable, so leaking a `null` here turns the next PATCH
      // — even an unrelated sibling change like remove_call_outcome — into a
      // "Input should be a valid boolean" failure.
      accepted.push({
        id: c.id,
        name: c.name,
        prompt,
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
    // Integrations are platform-side metadata; carry forward.
    integrations: fallback.integrations,
    // Todo list is builder-agent state — not stored upstream, carry forward.
    todo_list: fallback.todo_list,
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
    if (n.additional_prompt) data.prompt = n.additional_prompt;
    const extras = n as Record<string, unknown>;
    for (const k of ["tool_id", "target_agent_id", "phone_number"] as const) {
      if (extras[k] !== undefined) data[k] = extras[k];
    }
    return {
      id,
      type: ourTypeFor(n.type),
      label: n.label ?? id,
      data,
    };
  });
  const edges = Object.entries(remote.edges ?? {}).map(([id, e]) => {
    const cond = e.forward_condition;
    return {
      id,
      from: e.source,
      to: e.target,
      label: (e as Record<string, unknown>).label as string | undefined,
      condition:
        cond?.type === "llm" || cond?.type === "expression"
          ? cond.condition
          : undefined,
    };
  });
  return { nodes, edges };
}

function phaseFor(name: string, type: string): RuntimePhase {
  const n = name.toLowerCase();
  if (n.startsWith("pre_") || n.includes("pre_call")) return "pre_call";
  if (n.startsWith("post_") || n.includes("after_call") || n.includes("post_call"))
    return "post_call";
  if (type === "system") return "in_call";
  return "in_call";
}
