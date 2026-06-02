/**
 * Workflow capability.
 *
 * The agent builds a conversation flow graph (start → speak → collect →
 * tool_call → condition → transfer → end) as it shapes the voice agent.
 * Nodes + edges live in `config_cache.workflow` and stream to the right
 * panel via state_patch events so the SVG visualizer fills in live.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentPatch } from "@/lib/elevenlabs/agents/types";
import type {
  ElevenWorkflow,
  ElevenWorkflowEdge,
  ElevenWorkflowNode,
} from "@/lib/elevenlabs/client";
import type {
  RuntimeTool,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowState,
} from "@/types/agent";
import { DEFAULT_WORKFLOW } from "@/types/agent";
import { createLogger } from "@/lib/logger";
import type { Capability } from "../types";
import { runToolStep } from "../types";

const log = createLogger("capability:workflow");

/**
 * Translate our internal WorkflowState (arrays, our type names) into the
 * ElevenAgents `conversation_config.workflow` shape (object-keyed maps,
 * their type names). Used by every workflow-mutating path so the runtime
 * actually walks the graph instead of relying on prompt text.
 *
 * Mapping:
 *   start              → start
 *   speak / collect    → override_agent  (with additional_prompt)
 *   condition          → override_agent  (acts as a router via edge_order)
 *   tool_call          → dispatch_tool   (tool_id from data.tool_id)
 *   transfer           → agent_transfer | transfer_to_number  (data-dependent)
 *   end                → end
 *
 * Edges:
 *   our edge.condition (non-empty) → forward_condition: { type: "llm", condition }
 *   else                            → forward_condition: { type: "unconditional" }
 *   our edge.label  is preserved on the ElevenLabs side as `label` (passthrough).
 */
export function toElevenWorkflow(w: WorkflowState): ElevenWorkflow {
  // Transfer nodes that the user just dropped on the canvas (from the
  // "+" picker) may not have a destination yet — empty agent_id / no
  // phone / no sip. Shipping them to ElevenLabs trips a 422 like
  // "standalone_agent: agent_id is required". Detect those and skip
  // them (plus any edge touching them) so the upstream payload stays
  // valid. The local cache still keeps the node so the canvas shows
  // it; once the user fills in the destination, the next save propagates.
  const incompleteNodeIds = new Set<string>();
  for (const n of w.nodes) {
    if (n.type !== "transfer") continue;
    const d = n.data ?? {};
    const phone = typeof d.phone_number === "string" ? d.phone_number.trim() : "";
    const sip = typeof d.sip_uri === "string" ? d.sip_uri.trim() : "";
    const agent =
      typeof d.agent_id === "string"
        ? d.agent_id.trim()
        : typeof d.target_agent_id === "string"
          ? d.target_agent_id.trim()
          : "";
    if (!phone && !sip && !agent) {
      incompleteNodeIds.add(n.id);
    }
  }
  const isLive = (id: string) => !incompleteNodeIds.has(id);

  const outgoingByNode = new Map<string, WorkflowEdge[]>();
  for (const e of w.edges) {
    if (!isLive(e.from) || !isLive(e.to)) continue;
    const list = outgoingByNode.get(e.from) ?? [];
    list.push(e);
    outgoingByNode.set(e.from, list);
  }

  const nodes: Record<string, ElevenWorkflowNode> = {};
  for (const n of w.nodes) {
    if (!isLive(n.id)) continue;
    const out = outgoingByNode.get(n.id) ?? [];
    const edgeOrder = out.map((e) => e.id);
    const base: ElevenWorkflowNode = { type: "end", edge_order: edgeOrder };
    // `label` is only accepted on `override_agent` variants. Setting it on
    // start/end/tool/etc. trips strict-union validation upstream, which then
    // surfaces as the misleading "Workflow must contain a start node." 422.
    // Attach it inside the override_agent branch only.

    switch (n.type) {
      case "start":
        base.type = "start";
        break;
      case "end":
        base.type = "end";
        break;
      case "speak":
      case "collect":
      case "condition": {
        base.type = "override_agent";
        if (n.label) base.label = n.label;
        const prompt =
          (n.data?.prompt as string | undefined) ??
          (n.data?.instruction as string | undefined) ??
          (n.data?.expression as string | undefined);
        if (prompt) base.additional_prompt = prompt;
        // Per current spec, override_agent supports `additional_prompt`,
        // `additional_knowledge_base[]`, `additional_tool_ids[]`, and a
        // nested `conversation_config` (asr/turn/tts/conversation/
        // language_presets/vad/agent). We plumb all four through.
        const addToolIds = n.data?.additional_tool_ids;
        if (Array.isArray(addToolIds) && addToolIds.length > 0) {
          base.additional_tool_ids = addToolIds.filter(
            (t) => typeof t === "string",
          );
        }
        const addKb = n.data?.additional_knowledge_base;
        if (Array.isArray(addKb) && addKb.length > 0) {
          base.additional_knowledge_base = addKb;
        }
        const cc = buildNodeConversationConfig(n.data);
        if (cc) base.conversation_config = cc;
        break;
      }
      case "tool_call": {
        // Tool nodes hold an array of tool locators that run in parallel.
        // The node is considered successful only if all locators succeed.
        // We accept two shapes from `data`:
        //   - `tool_ids: string[]` — parallel execution (preferred)
        //   - `tool_id: string`    — legacy single-tool shorthand
        // and merge to a deduped, in-call-bound array on the wire.
        base.type = "tool";
        const ids: string[] = [];
        const toolIds = n.data?.tool_ids;
        if (Array.isArray(toolIds)) {
          for (const id of toolIds) {
            if (typeof id === "string" && id.length > 0 && !ids.includes(id))
              ids.push(id);
          }
        }
        const toolId = n.data?.tool_id;
        if (
          typeof toolId === "string" &&
          toolId.length > 0 &&
          !ids.includes(toolId)
        ) {
          ids.push(toolId);
        }
        if (ids.length > 0) base.tools = ids.map((tool_id) => ({ tool_id }));
        break;
      }
      case "transfer": {
        const phoneRaw = n.data?.phone_number as string | undefined;
        const sipRaw = n.data?.sip_uri as string | undefined;
        if (phoneRaw || sipRaw) {
          base.type = "phone_number";
          // `transfer_destination` is a discriminated union with four
          // variants — phone / phone_dynamic_variable / sip_uri /
          // sip_uri_dynamic_variable. We prefer `sip_uri` when both
          // fields are set (a SIP URI is more specific). Dynamic variant
          // is chosen when the value reads like a {{template}}.
          if (sipRaw) {
            base.transfer_destination = isDynamicVar(sipRaw)
              ? {
                  type: "sip_uri_dynamic_variable",
                  sip_uri: stripDynamicVar(sipRaw),
                }
              : { type: "sip_uri", sip_uri: sipRaw };
          } else if (phoneRaw) {
            base.transfer_destination = isDynamicVar(phoneRaw)
              ? {
                  type: "phone_dynamic_variable",
                  phone_number: stripDynamicVar(phoneRaw),
                }
              : { type: "phone", phone_number: phoneRaw };
          }
          const tType = n.data?.transfer_type;
          if (
            tType === "blind" ||
            tType === "conference" ||
            tType === "sip_refer"
          ) {
            base.transfer_type = tType;
          }
          const postDial = n.data?.post_dial_digits;
          if (typeof postDial === "string" && postDial.length > 0) {
            base.post_dial_digits = isDynamicVar(postDial)
              ? { type: "dynamic", value: stripDynamicVar(postDial) }
              : { type: "static", value: postDial };
          }
          const headers = n.data?.custom_sip_headers;
          if (Array.isArray(headers) && headers.length > 0) {
            base.custom_sip_headers = headers
              .filter(
                (h): h is { key: string; value: string; dynamic?: boolean } =>
                  !!h &&
                  typeof (h as { key?: unknown }).key === "string" &&
                  typeof (h as { value?: unknown }).value === "string",
              )
              .map((h) => ({
                type: h.dynamic ? "dynamic" : "static",
                key: h.key,
                value: h.dynamic ? stripDynamicVar(h.value) : h.value,
              }));
          }
        } else {
          base.type = "standalone_agent";
          // The wire field is `agent_id`. We accept the legacy internal
          // `target_agent_id` so cached agents from before this rename
          // still serialize correctly.
          const agentId =
            (n.data?.agent_id as string | undefined) ??
            (n.data?.target_agent_id as string | undefined);
          if (agentId) base.agent_id = agentId;
          const delayMs = n.data?.delay_ms;
          if (typeof delayMs === "number" && delayMs >= 0) {
            base.delay_ms = Math.floor(delayMs);
          }
          const transferMessage = n.data?.transfer_message;
          if (typeof transferMessage === "string" && transferMessage.length > 0) {
            base.transfer_message = transferMessage;
          }
          const enableFirst = n.data?.enable_transferred_agent_first_message;
          if (typeof enableFirst === "boolean") {
            base.enable_transferred_agent_first_message = enableFirst;
          }
        }
        break;
      }
    }
    // Position is a per-node hint the visual editor uses on both sides
    // (ours auto-lays out, ElevenLabs dashboard places by hand). Round-
    // tripping it means an agent re-saved by us doesn't lose the user's
    // hand-placed coordinates from the EL dashboard, and vice versa.
    if (n.position) {
      (base as Record<string, unknown>).position = {
        x: n.position.x,
        y: n.position.y,
      };
    }
    nodes[n.id] = base;
  }

  const edges: Record<string, ElevenWorkflowEdge> = {};
  for (const e of w.edges) {
    if (!isLive(e.from) || !isLive(e.to)) continue;
    edges[e.id] = {
      source: e.from,
      target: e.to,
      forward_condition: compileForwardCondition(e),
      ...(e.backward_condition
        ? { backward_condition: e.backward_condition }
        : {}),
    };
  }

  return {
    nodes,
    edges,
    ...(typeof w.prevent_subagent_loops === "boolean"
      ? { prevent_subagent_loops: w.prevent_subagent_loops }
      : {}),
  };
}

/**
 * Build the `forward_condition` for an outgoing edge. New code can set
 * `e.forward_condition` directly with any of the four variants. Legacy
 * edges only carry `e.condition` (LLM predicate) and/or `e.label`, which
 * we lift into the new shape so the wire payload always matches spec.
 */
function compileForwardCondition(
  e: WorkflowEdge,
): ElevenWorkflowEdge["forward_condition"] {
  if (e.forward_condition) {
    // Backfill label from the legacy edge-root label if the structured
    // form didn't carry one — preserves rendering after the rename.
    if (!e.forward_condition.label && e.label) {
      return { ...e.forward_condition, label: e.label };
    }
    return e.forward_condition;
  }
  if (e.condition && e.condition.trim().length > 0) {
    return {
      type: "llm",
      condition: e.condition,
      ...(e.label ? { label: e.label } : {}),
    };
  }
  return {
    type: "unconditional",
    ...(e.label ? { label: e.label } : {}),
  };
}

/**
 * Assemble the override_agent node's nested `conversation_config` from the
 * user-friendly convenience keys we surface in the inspector
 * (`override_voice_id`, `override_llm`, `override_first_message`) plus any
 * verbatim object the agent may have set via `conversation_config`.
 * Returns undefined when nothing overrides — keeps payloads compact.
 */
function buildNodeConversationConfig(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const verbatim =
    typeof data.conversation_config === "object" &&
    data.conversation_config !== null
      ? (data.conversation_config as Record<string, unknown>)
      : {};
  const built: Record<string, unknown> = {};
  const voice = data.override_voice_id;
  if (typeof voice === "string" && voice.length > 0) {
    built.tts = { ...(verbatim.tts as object | undefined), voice_id: voice };
  }
  const llm = data.override_llm;
  if (typeof llm === "string" && llm.length > 0) {
    const existingAgent =
      (verbatim.agent as Record<string, unknown> | undefined) ?? {};
    const existingPrompt =
      (existingAgent.prompt as Record<string, unknown> | undefined) ?? {};
    built.agent = {
      ...existingAgent,
      prompt: { ...existingPrompt, llm },
    };
  }
  const firstMessage = data.override_first_message;
  if (typeof firstMessage === "string" && firstMessage.length > 0) {
    const existingAgent =
      (built.agent as Record<string, unknown> | undefined) ??
      (verbatim.agent as Record<string, unknown> | undefined) ??
      {};
    built.agent = { ...existingAgent, first_message: firstMessage };
  }
  // Shallow-merge built keys over verbatim so the convenience keys win.
  const merged = { ...verbatim, ...built };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isDynamicVar(value: string): boolean {
  return /^\s*\{\{[^}]+\}\}\s*$/.test(value);
}

function stripDynamicVar(value: string): string {
  return value.replace(/[{}]/g, "").trim();
}

/**
 * Reverse direction: an ElevenLabs workflow object (returned by getAgent)
 * back into our internal WorkflowState. We can't perfectly recover the
 * original speak/collect/condition distinction (all three project as
 * override_agent on their side), so we default to `speak` for those.
 */
export function fromElevenWorkflow(w: ElevenWorkflow | undefined): WorkflowState | null {
  if (!w || !w.nodes) return null;

  const ourTypeFor = (t: ElevenWorkflowNode["type"]): WorkflowNodeType => {
    switch (t) {
      case "start":
        return "start";
      case "end":
        return "end";
      // ElevenLabs renamed: `dispatch_tool` → `tool`,
      // `agent_transfer` → `standalone_agent`,
      // `transfer_to_number` → `phone_number`. Accept both for backward
      // compat reading historical agents.
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

  const nodes: WorkflowNode[] = Object.entries(w.nodes).map(([id, n]) => {
    const data: Record<string, unknown> = {};
    const ext = n as Record<string, unknown>;
    if (n.additional_prompt) data.prompt = n.additional_prompt;
    // Tool node: current schema nests under `tools: [{ tool_id }, ...]`
    // and the runtime executes every entry in parallel. We preserve the
    // full array as `data.tool_ids` and ALSO populate `data.tool_id`
    // with the first entry so legacy inspector code and serializers
    // that read the singular form keep working.
    const toolsArr = ext.tools as Array<{ tool_id?: string }> | undefined;
    if (Array.isArray(toolsArr) && toolsArr.length > 0) {
      const ids = toolsArr
        .map((t) => t?.tool_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length > 0) {
        data.tool_ids = ids;
        data.tool_id = ids[0];
      }
    } else if (typeof ext.tool_id === "string") {
      data.tool_id = ext.tool_id;
      data.tool_ids = [ext.tool_id];
    }
    // Agent transfer: current schema uses `agent_id`. Accept legacy
    // `target_agent_id` so older cached agents read back.
    if (typeof ext.agent_id === "string") data.agent_id = ext.agent_id;
    else if (typeof ext.target_agent_id === "string")
      data.agent_id = ext.target_agent_id;
    if (typeof ext.delay_ms === "number") data.delay_ms = ext.delay_ms;
    if (typeof ext.transfer_message === "string")
      data.transfer_message = ext.transfer_message;
    if (typeof ext.enable_transferred_agent_first_message === "boolean")
      data.enable_transferred_agent_first_message =
        ext.enable_transferred_agent_first_message;
    // Phone transfer: current schema nests under
    // `transfer_destination: { type, phone_number/sip_uri }`. Phone and
    // SIP land in separate internal data keys so a re-save doesn't
    // collapse a SIP URI into a phone field (the previous bug). Dynamic
    // variants get re-wrapped into {{var}} syntax for the inspector.
    const td = ext.transfer_destination as
      | { type?: string; phone_number?: string; sip_uri?: string }
      | undefined;
    if (td?.phone_number) {
      data.phone_number =
        td.type === "phone_dynamic_variable"
          ? `{{${td.phone_number}}}`
          : td.phone_number;
    } else if (td?.sip_uri) {
      data.sip_uri =
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
    // override_agent extras: pass through additional_tool_ids /
    // additional_knowledge_base verbatim. The nested conversation_config
    // is also kept verbatim AND lifted into convenience keys so the panel
    // can edit voice / llm without round-tripping the whole nested shape.
    if (Array.isArray(ext.additional_tool_ids))
      data.additional_tool_ids = ext.additional_tool_ids;
    if (Array.isArray(ext.additional_knowledge_base))
      data.additional_knowledge_base = ext.additional_knowledge_base;
    const cc = ext.conversation_config as
      | { tts?: { voice_id?: string }; agent?: { prompt?: { llm?: string }; first_message?: string } }
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
    // Position is plumbed through verbatim. EL dashboard authors place
    // by hand; we auto-lay out when missing, so this only matters when
    // the same agent is opened in both editors.
    const rawPos = ext.position as { x?: unknown; y?: unknown } | undefined;
    const position =
      rawPos &&
      typeof rawPos.x === "number" &&
      typeof rawPos.y === "number"
        ? { x: rawPos.x, y: rawPos.y }
        : undefined;
    return {
      id,
      type: ourTypeFor(n.type),
      label: n.label ?? id,
      data,
      ...(position ? { position } : {}),
    };
  });

  const edges: WorkflowEdge[] = Object.entries(w.edges ?? {}).map(([id, e]) => {
    const fc = e.forward_condition;
    const bc = e.backward_condition;
    // Surface label from either the structured condition (current spec)
    // or the legacy edge-root `label` (older cached agents).
    const labelFromCondition = fc?.label;
    const labelFromLegacy = (e as Record<string, unknown>).label as
      | string
      | undefined;
    return {
      id,
      from: e.source,
      to: e.target,
      label: labelFromCondition ?? labelFromLegacy,
      // Keep the legacy `condition` populated when the variant is an LLM
      // predicate so existing inspector code (which reads e.condition) still
      // shows the natural-language string. The structured field stays the
      // canonical source.
      condition: fc?.type === "llm" ? fc.condition : undefined,
      forward_condition: fc,
      backward_condition: bc ?? undefined,
    };
  });

  return {
    nodes,
    edges,
    ...(typeof w.prevent_subagent_loops === "boolean"
      ? { prevent_subagent_loops: w.prevent_subagent_loops }
      : {}),
  };
}

const NodeTypeEnum = z.enum([
  "start",
  "speak",
  "collect",
  "tool_call",
  "condition",
  "transfer",
  "end",
]);

/**
 * Strip any legacy "--- WORKFLOW ---" prose footer from a system prompt.
 * We used to inline a markdown rendering of the graph here; now that the
 * structured workflow is pushed to conversation_config.workflow and the
 * runtime walks it itself, the footer is just noise. Kept here so existing
 * agents migrate cleanly the next time they're updated.
 */
export function composeSystemPromptWithWorkflow(prompt: string): string {
  const marker = "\n\n--- WORKFLOW ---\n";
  const idx = prompt.indexOf(marker);
  return idx === -1 ? prompt : prompt.slice(0, idx);
}

/**
 * Pre-flight validation matching ElevenLabs' upstream validator. We catch
 * the cases that would otherwise come back as opaque 422s ("workflow.edges:
 * Value error, …") and throw a clear, agent-actionable error first.
 *
 * Today the only rule we mirror is the most painful one: a single source
 * node may have AT MOST ONE unconditional outgoing edge. If the agent tries
 * to wire two `from: X` edges without conditions, upstream rejects because
 * the runtime branch-picker would be ambiguous.
 *
 * Throws on the first violation with enough context (node id, label, the
 * conflicting edge ids) for the agent to self-correct in one follow-up
 * tool call instead of guessing.
 */
function validateWorkflow(
  w: WorkflowState,
  /** Agent's currently-installed tools — used to detect pre/post-call tools
   *  being referenced from in-call `tool_call` workflow nodes (a category
   *  error: those tools fire from the call's envelope, not the workflow). */
  agentTools: RuntimeTool[] = [],
): void {
  // Exactly one start node. ElevenLabs auto-generates one during agent
  // creation and we hydrate its real id into the cache, so the model
  // should never add a second. Catching it here means a duplicate from
  // a sloppy set_workflow or add_node call surfaces as a clear,
  // agent-actionable error rather than silently rendering two start
  // nodes on the canvas.
  const startNodes = w.nodes.filter((n) => n.type === "start");
  if (startNodes.length === 0) {
    throw new Error(
      `Workflow must have exactly one node of type "start". None found.`,
    );
  }
  if (startNodes.length > 1) {
    const [keep, ...extras] = startNodes;
    throw new Error(
      `Workflow must have exactly one node of type "start". Found ${startNodes.length} (${startNodes
        .map((n) => `"${n.id}"`)
        .join(", ")}). The existing start node has id="${keep.id}" — reuse it instead of adding a new one (drop ${extras
        .map((n) => `"${n.id}"`)
        .join(", ")}).`,
    );
  }
  const labelById = new Map(w.nodes.map((n) => [n.id, n.label]));
  const unconditionalBySource = new Map<string, string[]>();
  for (const e of w.edges) {
    // Classify by the structured condition first, then fall back to the
    // legacy `condition` string. Mirrors compileForwardCondition so the
    // validator and serializer agree on whether an edge is unconditional.
    const fc =
      e.forward_condition ??
      (e.condition && e.condition.trim().length > 0
        ? ({ type: "llm" } as const)
        : ({ type: "unconditional" } as const));
    if (fc.type !== "unconditional") continue;
    const list = unconditionalBySource.get(e.from) ?? [];
    list.push(e.id);
    unconditionalBySource.set(e.from, list);
  }
  for (const [sourceId, edgeIds] of unconditionalBySource) {
    if (edgeIds.length > 1) {
      const label = labelById.get(sourceId) ?? "(unknown)";
      throw new Error(
        `Node "${sourceId}" ("${label}") has ${edgeIds.length} unconditional outgoing edges (${edgeIds.join(
          ", ",
        )}). Upstream requires at most one unconditional next step per node — keep one as the default and put a natural-language condition on the rest (e.g. "the caller wants billing"), OR remove the extras.`,
      );
    }
  }
  // Upstream also rejects ANY two edges that share (source, target), even
  // when their forward_condition differs (e.g. result:true vs result:false).
  // The runtime branch-picker disambiguates by condition, but the validator
  // does not — so we must collapse parallel edges into one before PATCH.
  // NUL separator so node ids containing arrows or dashes can't collide.
  const edgesByPair = new Map<string, string[]>();
  for (const e of w.edges) {
    const key = `${e.from} ${e.to}`;
    const list = edgesByPair.get(key) ?? [];
    list.push(e.id);
    edgesByPair.set(key, list);
  }
  for (const [key, edgeIds] of edgesByPair) {
    if (edgeIds.length < 2) continue;
    const [fromId, toId] = key.split(" ");
    const fromLabel = labelById.get(fromId) ?? "(unknown)";
    const toLabel = labelById.get(toId) ?? "(unknown)";
    throw new Error(
      `Edges ${edgeIds.map((id) => `"${id}"`).join(", ")} all connect "${fromId}" ("${fromLabel}") → "${toId}" ("${toLabel}"). Upstream treats any two edges sharing the same source/target pair as duplicates — even when their conditions differ. If both branches really lead to the same node, keep one edge and make it unconditional. If success and failure should diverge (e.g. failure goes to a recovery speak node first), split into separate target nodes.`,
    );
  }
  // tool_call nodes can only reference IN-CALL tools. Pre/post-call tools
  // fire from the call's envelope (pre via enrichCallContext before dial,
  // post via the post-call webhook) and have `local_…` ids that ElevenLabs
  // never sees — putting them in the in-call graph means a workflow node
  // that fails to fire AND duplicates work that already happened. Reject
  // upfront with an actionable error.
  const toolsById = new Map(agentTools.map((t) => [t.id, t]));
  const toolsByName = new Map(agentTools.map((t) => [t.name, t]));
  for (const n of w.nodes) {
    if (n.type !== "tool_call") continue;
    const data = n.data as
      | {
          tool_id?: unknown;
          tool_ids?: unknown;
          tool_name?: unknown;
        }
      | undefined;
    // Build the union of every tool id referenced by this node — both
    // the singular `tool_id` (single-tool shorthand) and the array
    // `tool_ids` (parallel execution). Each id must be a real in-call
    // binding for the wire payload to be valid.
    const ids: string[] = [];
    if (typeof data?.tool_id === "string" && data.tool_id.length > 0) {
      ids.push(data.tool_id);
    }
    if (Array.isArray(data?.tool_ids)) {
      for (const raw of data.tool_ids) {
        if (typeof raw === "string" && raw.length > 0 && !ids.includes(raw)) {
          ids.push(raw);
        }
      }
    }
    // Fallback: pure `tool_name` reference (no id at all). Resolve to a
    // single binding for the phase-check below.
    const nameRef =
      ids.length === 0 && typeof data?.tool_name === "string"
        ? toolsByName.get(data.tool_name)
        : null;
    if (ids.length === 0 && nameRef) {
      ids.push(nameRef.id);
    }
    for (const id of ids) {
      const ref = toolsById.get(id);
      if (!ref) {
        // An id was provided but doesn't match any binding. With
        // `config.tools` derived from `workflow.bindings`, an unknown
        // id means the binding was dropped (uninstalled) since the
        // node was authored. Surface this so the agent (or user)
        // replaces the reference instead of letting a dead node ship.
        throw new Error(
          `tool_call node "${n.id}" references tool_id "${id}" which is not bound to this agent. ` +
          `Install the tool first (install_provider_tool / write_tool) or pick an existing one. ` +
          `Currently attached: ${
            agentTools.filter((t) => t.phase === "in_call").map((t) => t.name).join(", ") || "(none)"
          }.`,
        );
      }
      if (ref.phase !== "in_call") {
        throw new Error(
          `tool_call node "${n.id}" references "${ref.name}" which is a ${ref.phase} tool. ` +
          `${ref.phase} tools fire automatically from the call's envelope, not from the workflow graph — ` +
          `the workflow only runs DURING the conversation. Remove this node. ` +
          (ref.phase === "pre_call"
            ? `The lookup already ran before the call connected; its output is in dynamic variables ` +
              `(e.g. {{caller_name}}, {{caller_company}}) — reference those in your speak/collect prompts instead.`
            : `Add a data_collection field for the value you want logged; the post-call tool will pick it up after hangup.`),
        );
      }
    }
  }

  // override_agent nodes (speak / collect / condition) can carry
  // `additional_tool_ids`: tools the LLM gets access to *only* while
  // that node is active. They must reference real bindings, and they
  // must be in-call tools (lifecycle ids are never exposed to EL).
  const externalIds = new Set(
    agentTools.filter((t) => t.phase === "in_call").map((t) => t.id),
  );
  for (const n of w.nodes) {
    const addIds = (n.data as { additional_tool_ids?: unknown })?.additional_tool_ids;
    if (!Array.isArray(addIds)) continue;
    for (const raw of addIds) {
      if (typeof raw !== "string") {
        throw new Error(
          `Node "${n.id}" has a non-string entry in additional_tool_ids — every entry must be a tool id.`,
        );
      }
      if (!externalIds.has(raw)) {
        const ref = toolsById.get(raw);
        if (ref && ref.phase !== "in_call") {
          throw new Error(
            `Node "${n.id}" additional_tool_ids includes "${raw}" (${ref.phase} tool "${ref.name}"). ` +
            `Only in-call tools can be scoped to a node — ${ref.phase} tools fire from the call envelope.`,
          );
        }
        throw new Error(
          `Node "${n.id}" additional_tool_ids includes "${raw}" which is not bound to this agent. ` +
          `Install the tool first or drop the reference. ` +
          `Available in-call tool ids: ${[...externalIds].join(", ") || "(none)"}.`,
        );
      }
    }
  }

  // Edges must reference existing nodes. set_workflow already checks this,
  // but edit_workflow's add_edge can let stale ids through if the agent
  // composes ops sloppily. A clear pre-flight beats a 404 from upstream.
  const nodeIds = new Set(w.nodes.map((n) => n.id));
  for (const e of w.edges) {
    if (!nodeIds.has(e.from)) {
      throw new Error(
        `Edge "${e.id}" references unknown source node "${e.from}". Available node ids: ${[
          ...nodeIds,
        ].join(", ")}.`,
      );
    }
    if (!nodeIds.has(e.to)) {
      throw new Error(
        `Edge "${e.id}" references unknown target node "${e.to}". Available node ids: ${[
          ...nodeIds,
        ].join(", ")}.`,
      );
    }
  }
}

/**
 * ElevenLabs hardcodes the canonical id of the workflow's start node to
 * `start_node` (it's what their auto-generated workflow uses on agent
 * creation, and what the docs example uses). When the upstream validator
 * doesn't find a node with that exact id it surfaces the misleading
 * "Workflow must contain a start node." 422 even though our payload has a
 * `type: "start"` node under a different id (e.g. "start").
 *
 * Normalize at the boundary: if the workflow's single start node uses a
 * non-canonical id, rename it (and rewrite any edges that reference it)
 * so cache, panel route, and upstream all agree.
 */
const CANONICAL_START_ID = "start_node";

export function normalizeStartNodeId(w: WorkflowState): WorkflowState {
  const start = w.nodes.find((n) => n.type === "start");
  if (!start || start.id === CANONICAL_START_ID) return w;
  const oldId = start.id;
  return {
    nodes: w.nodes.map((n) =>
      n.id === oldId ? { ...n, id: CANONICAL_START_ID } : n,
    ),
    edges: w.edges.map((e) => ({
      ...e,
      from: e.from === oldId ? CANONICAL_START_ID : e.from,
      to: e.to === oldId ? CANONICAL_START_ID : e.to,
    })),
  };
}

/**
 * Build the upstream PATCH payload that pushes this workflow onto
 * conversation_config.workflow (the agent runtime walks the graph itself —
 * no prompt footer required). Also scrubs any legacy footer from the system
 * prompt. The caller hands the returned `upstreamPatch` back to runToolStep
 * so the actual ElevenLabs PATCH is deferred until end of turn.
 */
function buildWorkflowPatch(
  ctx: Parameters<Capability["tools"]>[0],
  nextWorkflow: WorkflowState,
): { workflow: WorkflowState; cleanPrompt: string; upstreamPatch: AgentPatch } {
  const tTotal = Date.now();
  nextWorkflow = normalizeStartNodeId(nextWorkflow);
  validateWorkflow(nextWorkflow, ctx.config.tools);
  const cleanPrompt = composeSystemPromptWithWorkflow(
    ctx.config.system_prompt ?? "",
  );
  const tTranslate = Date.now();
  const workflow = toElevenWorkflow(nextWorkflow);
  const promptChanged = cleanPrompt !== ctx.config.system_prompt;
  log.info("buildWorkflowPatch done", {
    agent_id: ctx.elevenlabs_agent_id,
    turn_job_id: ctx.turn_job_id,
    nodes: nextWorkflow.nodes.length,
    edges: nextWorkflow.edges.length,
    translate_ms: Date.now() - tTranslate,
    total_ms: Date.now() - tTotal,
    prompt_trimmed: promptChanged,
  });
  return {
    workflow: nextWorkflow,
    cleanPrompt,
    upstreamPatch: {
      workflow,
      ...(promptChanged ? { system_prompt: cleanPrompt } : {}),
    },
  };
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// ── set_workflow / edit_workflow schemas ────────────────────────────────

const NodeInput = z.object({
  /** Optional. Omit when adding a fresh node; provide to keep a stable id
   *  across set_workflow calls so React + ElevenLabs treat it as the same node. */
  id: z.string().optional(),
  type: NodeTypeEnum,
  label: z.string().min(1).max(80),
  data: z.record(z.string(), z.unknown()).default({}),
  /** Optional hand-placed coordinates on the visual editor. Our canvas
   *  auto-lays out when missing; only set this if you actually want to
   *  pin a node at a specific point (e.g. matching an EL-dashboard
   *  layout the user is mirroring). */
  position: z
    .object({ x: z.number(), y: z.number() })
    .optional(),
});

/**
 * Structured edge condition. One of:
 *   - { type: "unconditional", label? }
 *   - { type: "llm", condition, label? }          — LLM-evaluated predicate
 *   - { type: "expression", expression, label? }  — deterministic AST eval
 *   - { type: "result", successful, label? }      — tool-node success/fail
 */
const EdgeConditionInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unconditional"), label: z.string().optional() }),
  z.object({
    type: z.literal("llm"),
    condition: z.string().min(1),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("expression"),
    expression: z.unknown(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("result"),
    successful: z.boolean(),
    label: z.string().optional(),
  }),
]);

const EdgeInput = z.object({
  id: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  /** Shortcut for { type: "unconditional", label } or condition-side label. */
  label: z.string().optional(),
  /** Shortcut for { type: "llm", condition }. Ignored if forward_condition is set. */
  condition: z.string().optional(),
  forward_condition: EdgeConditionInput.optional(),
  backward_condition: EdgeConditionInput.optional(),
});

const EditOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: NodeInput }),
  z.object({
    op: z.literal("update_node"),
    id: z.string().min(1),
    label: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    type: NodeTypeEnum.optional(),
  }),
  z.object({ op: z.literal("remove_node"), id: z.string().min(1) }),
  z.object({ op: z.literal("add_edge"), edge: EdgeInput }),
  z.object({
    op: z.literal("update_edge"),
    id: z.string().min(1),
    label: z.string().optional(),
    condition: z.string().optional(),
    forward_condition: EdgeConditionInput.optional(),
    backward_condition: EdgeConditionInput.nullable().optional(),
  }),
  z.object({ op: z.literal("remove_edge"), id: z.string().min(1) }),
  /** Toggle the workflow-level `prevent_subagent_loops` flag. */
  z.object({
    op: z.literal("set_prevent_subagent_loops"),
    value: z.boolean(),
  }),
]);

type EditOpT = z.infer<typeof EditOp>;

function applyOps(
  state: WorkflowState,
  ops: EditOpT[],
): WorkflowState {
  let nodes = [...state.nodes];
  let edges = [...state.edges];
  let preventSubagentLoops = state.prevent_subagent_loops;
  for (const op of ops) {
    switch (op.op) {
      case "add_node": {
        const id = op.node.id ?? newId(op.node.type);
        if (nodes.some((n) => n.id === id))
          throw new Error(`Node id "${id}" already exists.`);
        nodes.push({
          id,
          type: op.node.type,
          label: op.node.label,
          data: op.node.data ?? {},
          ...(op.node.position ? { position: op.node.position } : {}),
        });
        break;
      }
      case "update_node": {
        const idx = nodes.findIndex((n) => n.id === op.id);
        if (idx === -1) throw new Error(`No node with id "${op.id}".`);
        const cur = nodes[idx];
        nodes[idx] = {
          ...cur,
          type: op.type ?? cur.type,
          label: op.label ?? cur.label,
          data: op.data ? { ...cur.data, ...op.data } : cur.data,
        };
        break;
      }
      case "set_prevent_subagent_loops": {
        preventSubagentLoops = op.value;
        break;
      }
      case "remove_node": {
        const target = nodes.find((n) => n.id === op.id);
        if (target?.type === "start")
          throw new Error("Cannot remove the start node.");
        if (!nodes.some((n) => n.id === op.id))
          throw new Error(`No node with id "${op.id}".`);
        nodes = nodes.filter((n) => n.id !== op.id);
        edges = edges.filter((e) => e.from !== op.id && e.to !== op.id);
        break;
      }
      case "add_edge": {
        const id = op.edge.id ?? newId("edge");
        if (edges.some((e) => e.id === id))
          throw new Error(`Edge id "${id}" already exists.`);
        if (!nodes.some((n) => n.id === op.edge.from))
          throw new Error(`from "${op.edge.from}" does not exist.`);
        if (!nodes.some((n) => n.id === op.edge.to))
          throw new Error(`to "${op.edge.to}" does not exist.`);
        edges.push({
          id,
          from: op.edge.from,
          to: op.edge.to,
          label: op.edge.label,
          condition: op.edge.condition,
          forward_condition: op.edge.forward_condition,
          backward_condition: op.edge.backward_condition ?? undefined,
        });
        break;
      }
      case "update_edge": {
        const idx = edges.findIndex((e) => e.id === op.id);
        if (idx === -1) throw new Error(`No edge with id "${op.id}".`);
        const cur = edges[idx];
        edges[idx] = {
          ...cur,
          label: op.label ?? cur.label,
          condition: op.condition ?? cur.condition,
          forward_condition: op.forward_condition ?? cur.forward_condition,
          // `null` explicitly clears the backward edge (loop removal).
          backward_condition:
            op.backward_condition === null
              ? undefined
              : op.backward_condition ?? cur.backward_condition,
        };
        break;
      }
      case "remove_edge": {
        if (!edges.some((e) => e.id === op.id))
          throw new Error(`No edge with id "${op.id}".`);
        edges = edges.filter((e) => e.id !== op.id);
        break;
      }
    }
  }
  return {
    nodes,
    edges,
    ...(typeof preventSubagentLoops === "boolean"
      ? { prevent_subagent_loops: preventSubagentLoops }
      : {}),
  };
}

export const workflowCapability: Capability = {
  id: "workflow",
  label: "Workflow",
  defaultSlice: () => ({ workflow: { ...DEFAULT_WORKFLOW } }),
  tools: (ctx) => [
    tool(
      "set_workflow",
      // Big up-front graph definition. Use this when building a workflow
      // from scratch — one call, whole graph. Cheaper than 12 add_node +
      // edge calls and keeps the canvas from flickering as nodes pop in.
      "Define (or REPLACE) the entire conversation workflow in a single call. Provide the full `nodes` and `edges` arrays. Use this when first building the workflow or when rewriting it wholesale. For incremental tweaks (rename a node, add one branch, etc.) use `edit_workflow` instead.\n\nThe workflow is the single source of truth for tools. `tool_call` nodes (and the optional per-node `additional_tool_ids`) reference bindings that already exist in `workflow.bindings` — created via `install_provider_tool`, `write_tool`, or `create_custom_runtime_tool`. Saving the workflow re-derives `config.tools` from bindings and patches ElevenLabs. Referencing a tool id that isn't bound throws a clear error; install it first.\n\nNode types: 'start' (always exactly one, id='start'), 'speak' (agent says something — put the line in data.prompt), 'collect' (ask the caller for a value — data.prompt for the question, data.field for the variable name), 'condition' (router that branches on outgoing edges' conditions — data.expression names the variable being checked), 'tool_call' (run runtime tools — use data.tool_id for a single tool OR data.tool_ids[] to fire several IN PARALLEL on the same node; every id must reference an existing in-call binding, and the node only counts as successful if ALL listed tools succeed), 'transfer' (hand off — data.agent_id for transfer to another ElevenLabs agent + optional data.delay_ms/transfer_message/enable_transferred_agent_first_message; OR set data.phone_number for an E.164 phone transfer; OR set data.sip_uri for a SIP URI transfer (e.g. 'sip:alice@example.com'). Either destination accepts optional data.transfer_type ('blind'|'conference'|'sip_refer'), data.post_dial_digits, data.custom_sip_headers. Wrap a value in {{var}} to make it a dynamic variable.), 'end' (hang up).\n\nOverride-agent (speak/collect/condition) extras: data.additional_tool_ids[] (in-call binding ids the agent can call only while in this node), data.additional_knowledge_base[], data.override_voice_id, data.override_llm, data.override_first_message — these tighten what the agent can do at that node only.\n\nOptional per-node `position: { x, y }` — only set if you're mirroring a hand-placed layout (e.g. matching ElevenLabs dashboard coordinates). Our canvas auto-lays out otherwise.\n\nEdges: connect node ids via `from`/`to`. Set `forward_condition` with one of:\n  - { type: 'unconditional', label }\n  - { type: 'llm', condition: 'the caller confirmed', label }  ← MOST COMMON\n  - { type: 'expression', expression: <AST>, label }            ← deterministic; rarely needed — prefer 'llm'\n  - { type: 'result', successful: true|false, label }           ← branch off a tool node's success/failure\n\n**Edges leaving conversational nodes (speak / collect / condition) should use 'llm' (or 'expression'), NOT 'unconditional'.** An unconditional exit is satisfied immediately, so the agent races through every node to 'end' and hangs up before it can talk. The condition states WHEN to advance (e.g. 'the caller's question has been answered'). Reserve 'unconditional' for the start→first-node edge and a tool_call node's single default exit.\n\n**ALWAYS include a short `label` (≤50 chars)** on every condition — that's exactly what renders on the dark pill on the edge in the canvas, and is the only thing the user sees without hovering. Bad: omitting the label so the full `condition` string spills onto the canvas. Good: `label: 'wants billing'` + `condition: 'the caller wants to discuss billing or invoices'`.\n\nLegacy shortcuts also work: a top-level `condition` string is treated as { type: 'llm' }, and a top-level `label` is lifted into the condition's label. For loops, set `backward_condition` on the same edge (don't add a flipped sibling edge). At most ONE edge per (from, to) pair — upstream rejects duplicates even when their conditions differ. If both branches go to the same node, collapse to a single unconditional edge; otherwise split the targets.\n\nTop-level `prevent_subagent_loops: true` blocks the runtime from transferring back to an agent already on the call's transfer stack — set when chaining `standalone_agent` transfers across multiple agents.",
      {
        nodes: z.array(NodeInput).min(1).max(40),
        edges: z.array(EdgeInput).max(80).default([]),
        prevent_subagent_loops: z.boolean().optional(),
      },
      async ({ nodes, edges, prevent_subagent_loops }) =>
        runToolStep(ctx, "workflow", "set_workflow", async () => {
          log.info("set_workflow entry", {
            turn_job_id: ctx.turn_job_id,
            input_nodes: nodes.length,
            input_edges: edges.length,
            node_types: nodes.reduce<Record<string, number>>((acc, n) => {
              acc[n.type] = (acc[n.type] ?? 0) + 1;
              return acc;
            }, {}),
            edges_with_condition: edges.filter(
              (e) =>
                (typeof e.condition === "string" && e.condition.length > 0) ||
                !!e.forward_condition,
            ).length,
            prevent_subagent_loops,
          });
          // Stamp missing ids so the agent doesn't have to.
          const stampedNodes: WorkflowNode[] = nodes.map((n) => ({
            id: n.id ?? newId(n.type),
            type: n.type,
            label: n.label,
            data: n.data ?? {},
            ...(n.position ? { position: n.position } : {}),
          }));
          const knownIds = new Set(stampedNodes.map((n) => n.id));
          const stampedEdges: WorkflowEdge[] = edges.map((e) => {
            if (!knownIds.has(e.from))
              throw new Error(`Edge "from" references unknown node "${e.from}".`);
            if (!knownIds.has(e.to))
              throw new Error(`Edge "to" references unknown node "${e.to}".`);
            return {
              id: e.id ?? newId("edge"),
              from: e.from,
              to: e.to,
              label: e.label,
              condition: e.condition,
              forward_condition: e.forward_condition,
              backward_condition: e.backward_condition,
            };
          });
          const next: WorkflowState = {
            nodes: stampedNodes,
            edges: stampedEdges,
            ...(typeof prevent_subagent_loops === "boolean"
              ? { prevent_subagent_loops }
              : {}),
          };
          const result = buildWorkflowPatch(ctx, next);
          return {
            patch: {
              workflow: result.workflow,
              system_prompt: result.cleanPrompt,
            },
            upstreamPatch: result.upstreamPatch,
            summary: `Workflow set: ${stampedNodes.length} nodes, ${stampedEdges.length} edges.`,
          };
        }),
    ),

    tool(
      "edit_workflow",
      "Apply a list of incremental edits to the existing workflow WITHOUT having to re-send the whole graph. Operations run in order, so you can rename a node, add two new branches, and remove an edge in one call. Cheaper than rewriting the workflow with set_workflow when only a few things change.\n\nEach `operations` entry is one of:\n- { op: 'add_node', node: { type, label, data?, id?, position? } }  (data shape mirrors set_workflow — tool_call accepts data.tool_id or data.tool_ids[]; transfer accepts data.phone_number or data.sip_uri)\n- { op: 'update_node', id, label?, data?, type? }  (data is shallow-merged into node.data)\n- { op: 'remove_node', id }  (also drops any edges touching the node; cannot remove 'start')\n- { op: 'add_edge', edge: { from, to, label?, condition?, forward_condition?, backward_condition?, id? } }  (always set a short label ≤50 chars — that's the pill text on the canvas)\n- { op: 'update_edge', id, label?, condition?, forward_condition?, backward_condition? }  (set backward_condition to null to remove a back-edge / kill a loop)\n- { op: 'remove_edge', id }\n- { op: 'set_prevent_subagent_loops', value: true|false }  (workflow-level — blocks the runtime from transferring back into an agent already on the call's transfer stack)",
      {
        operations: z.array(EditOp).min(1).max(40),
      },
      async ({ operations }) =>
        runToolStep(ctx, "workflow", "edit_workflow", async () => {
          log.info("edit_workflow entry", {
            turn_job_id: ctx.turn_job_id,
            ops: operations.length,
            op_kinds: operations.reduce<Record<string, number>>((acc, o) => {
              acc[o.op] = (acc[o.op] ?? 0) + 1;
              return acc;
            }, {}),
            current_nodes: ctx.config.workflow.nodes.length,
            current_edges: ctx.config.workflow.edges.length,
          });
          const next = applyOps(ctx.config.workflow, operations);
          const result = buildWorkflowPatch(ctx, next);
          return {
            patch: {
              workflow: result.workflow,
              system_prompt: result.cleanPrompt,
            },
            upstreamPatch: result.upstreamPatch,
            summary: `Applied ${operations.length} edit${operations.length === 1 ? "" : "s"} to the workflow.`,
          };
        }),
    ),

    tool(
      "workflow_reset",
      "Wipe the entire conversation workflow back to just a start node. Use only when explicitly asked, or before a fresh set_workflow call on a previously-built agent.",
      {},
      async () =>
        runToolStep(ctx, "workflow", "workflow_reset", async () => {
          log.info("workflow_reset entry", {
            turn_job_id: ctx.turn_job_id,
            current_nodes: ctx.config.workflow.nodes.length,
            current_edges: ctx.config.workflow.edges.length,
          });
          const next: WorkflowState = { ...DEFAULT_WORKFLOW };
          const result = buildWorkflowPatch(ctx, next);
          return {
            patch: {
              workflow: result.workflow,
              system_prompt: result.cleanPrompt,
            },
            upstreamPatch: result.upstreamPatch,
            summary: "Workflow reset.",
          };
        }),
    ),
  ],
};
