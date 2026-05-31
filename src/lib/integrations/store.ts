/**
 * Workspace-shared integration lookup.
 *
 * Integrations (HubSpot, Google Calendar, …) used to be scoped per agent —
 * each agent that wanted to use HubSpot would re-paste its PAT. With this
 * helper they're scoped to **the workspace**: connect HubSpot once on any
 * agent, and every other agent in the workspace sees it as connected and
 * can install its tools using the same shared OAuth token.
 *
 * The schema doesn't change. `IntegrationDocument.agent_id` remains and
 * indicates *which agent first connected the provider* (informational —
 * useful for audit, not for routing). Reads ignore it.
 *
 * Future work: when accounts/tenants are introduced, swap the constant
 * below for the caller's resolved workspace id. Every read site already
 * goes through this helper, so the migration is a single edit.
 */
import type { Collection, ObjectId } from "mongodb";
import { integrationsCol } from "@/lib/mongodb";
import type { IntegrationDocument } from "@/types/agent";

/**
 * Find the workspace's integration document for a given provider, regardless
 * of which agent originally connected it. Returns null if no integration
 * exists or if the status is not "connected".
 *
 * Pass `requireConnected: false` to also return disconnected / expired rows
 * (the disconnect flow does this so it can tear down the existing row).
 */
export async function findWorkspaceIntegration(
  provider: string,
  opts: { requireConnected?: boolean } = {},
): Promise<IntegrationDocument | null> {
  const ints: Collection<IntegrationDocument> = await integrationsCol();
  const filter: Record<string, unknown> = { provider };
  if (opts.requireConnected !== false) filter.status = "connected";
  return ints.findOne(filter as Parameters<typeof ints.findOne>[0]);
}

/**
 * The set of providers currently connected in the workspace. Used by the
 * Tools-tab catalog and the workflow tab's phantom column picker to render
 * "Connected" badges and gate one-click install.
 *
 * Built-in providers marked `always_connected: true` (e.g. Alta itself —
 * its tools read our own DB, no OAuth needed) are added to the set
 * unconditionally so the UI never asks the user to "Connect" the
 * platform to itself.
 */
export async function listConnectedWorkspaceProviders(): Promise<Set<string>> {
  const ints = await integrationsCol();
  const rows = await ints
    .find({ status: "connected" })
    .project({ provider: 1 })
    .toArray();
  const set = new Set(rows.map((r) => (r as { provider: string }).provider));
  const { PROVIDERS } = await import("./providers");
  for (const p of PROVIDERS) {
    if (p.always_connected) set.add(p.id);
  }
  return set;
}

/**
 * Resolve the proxy_secret for a workspace-scoped integration. The proxy
 * route uses this to verify the Authorization bearer ElevenLabs sends with
 * every tool webhook hit.
 */
export async function getProxySecret(
  provider: string,
): Promise<string | null> {
  const doc = await findWorkspaceIntegration(provider);
  const secret = (doc?.metadata as { proxy_secret?: unknown } | undefined)
    ?.proxy_secret;
  return typeof secret === "string" ? secret : null;
}

/** Marker re-exported so callers that don't need lookups can still import the ObjectId. */
export type { ObjectId };
