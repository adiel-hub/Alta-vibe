/**
 * Outbound pre-call enrichment. Runs BEFORE we ask ElevenLabs to dial so
 * the `dynamic_variables` we hand to the outbound API already carry CRM
 * context — the agent's first TTS chunk can reference {{caller_name}}
 * etc.
 *
 * Two parallel sources merge into one string-map:
 *
 *   1. The HubSpot "lookup by phone/email" fast path
 *      (`lookupContactByEmailOrPhone`). Kept hard-wired because v1 of the
 *      HubSpot integration auto-injected this and we don't want to
 *      regress for users already relying on it.
 *
 *   2. Any other `pre_call`-phase tool registered on the agent — fired
 *      through the generic lifecycle dispatcher, with results flattened
 *      into the variable map under `pre_<tool_name>__<field>` keys.
 *
 * Per-provider failures collapse to `{}` so a 500 from one CRM never
 * blocks the call from happening.
 *
 * Inbound calls are not supported in this v1 path — ElevenLabs would
 * need to hit a webhook on us before the greeting, which isn't wired up
 * yet. For inbound, configure dynamic_variables through ElevenLabs' own
 * conversation_initiation_client_data flow directly.
 */
import { ObjectId } from "mongodb";
import { agentsCol } from "@/lib/mongodb";
import { dispatchLifecycle } from "@/lib/elevenlabs/lifecycle/dispatch";
import { findWorkspaceIntegration } from "./store";
import { lookupContactByEmailOrPhone } from "./hubspot/lookup";

export async function enrichCallContext(input: {
  agentMongoId: string;
  to_number: string;
  caller_email?: string;
}): Promise<Record<string, string>> {
  if (!ObjectId.isValid(input.agentMongoId)) return {};
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(input.agentMongoId) });
  if (!agent) return {};

  const merged: Record<string, string> = {};

  // 1) HubSpot fast path — fires when the WORKSPACE has a connected
  //    HubSpot integration (any agent's connection works). The workspace
  //    `integrations` collection is the sole source of truth for
  //    connection status.
  const hasHubspot = !!(await findWorkspaceIntegration("hubspot"));
  if (hasHubspot) {
    const out = await lookupContactByEmailOrPhone(input.agentMongoId, {
      email: input.caller_email,
      phone: input.to_number,
    });
    Object.assign(merged, out);
  }

  // 2) Generic pre_call tool dispatch — every tool on the agent whose
  //    phase is "pre_call" gets fired with the caller context. Scalar
  //    fields on each tool's JSON response are folded into the variable
  //    map under `pre_<tool_name>__<field>` so multiple pre_call tools
  //    can coexist without clobbering each other's output keys.
  const ctx = {
    caller_id: input.to_number,
    to_number: input.to_number,
    caller_email: input.caller_email ?? "",
  };
  const results = await dispatchLifecycle(agent._id, "pre_call", ctx);
  for (const r of results) {
    if (!r.ok || r.output === null || typeof r.output !== "object") continue;
    for (const [k, v] of Object.entries(r.output as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        merged[`pre_${r.tool_name}__${k}`] = String(v);
      }
    }
  }

  return merged;
}
