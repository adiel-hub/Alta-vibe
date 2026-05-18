/**
 * Multi-provider pre-call enrichment. Looks at the agent's connected
 * integrations, dispatches per-provider lookups, merges the results
 * into a single string-map that becomes `dynamic_variables` on the
 * outbound call. Per-provider failures collapse to `{}` so a 500 from
 * one CRM never blocks the call from happening.
 */
import { ObjectId } from "mongodb";
import { agentsCol } from "@/lib/mongodb";
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

  const connected = agent.config_cache.integrations.filter(
    (i) => i.status === "connected",
  );

  const merged: Record<string, string> = {};
  for (const integration of connected) {
    if (integration.provider === "hubspot") {
      const out = await lookupContactByEmailOrPhone(input.agentMongoId, {
        email: input.caller_email,
        phone: input.to_number,
      });
      Object.assign(merged, out);
    }
    // Future: stripe / salesforce / etc. each contribute their own keys.
  }
  return merged;
}
