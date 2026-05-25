/**
 * HubSpot Private App token helpers. PATs don't refresh, so there's no
 * token lifecycle to manage — just validate at connect time, then decrypt
 * + use on each request.
 */
import { ObjectId } from "mongodb";
import { integrationsCol } from "@/lib/mongodb";
import { findWorkspaceIntegration } from "@/lib/integrations/store";
import { decryptToken } from "@/lib/integrations/tokens";

export type HubspotAccountInfo = {
  portalId: number;
  accountType?: string;
  timeZone?: string;
  companyCurrency?: string;
  uiDomain?: string;
};

/**
 * Hit /account-info/v3/details to confirm the PAT is real and unrevoked.
 * Returns the account info on success; null on auth failure.
 */
export async function validateToken(
  token: string,
): Promise<HubspotAccountInfo | null> {
  try {
    const res = await fetch("https://api.hubapi.com/account-info/v3/details", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as HubspotAccountInfo;
    return json;
  } catch {
    return null;
  }
}

/**
 * Decrypt the stored HubSpot PAT for the given agent. Returns null if
 * there is no connected integration row.
 */
export async function getHubspotToken(
  // Kept as a parameter for backwards compat with existing call sites,
  // but no longer used — integrations are now workspace-shared, so we
  // look up by provider alone. Future per-account scoping will resolve
  // the workspace from session context inside findWorkspaceIntegration.
  _agentMongoId?: string,
): Promise<string | null> {
  const doc = await findWorkspaceIntegration("hubspot");
  if (!doc) return null;
  const blob = (doc.credentials as { access_token?: unknown }).access_token;
  if (typeof blob !== "string") return null;
  try {
    return decryptToken(blob);
  } catch {
    return null;
  }
}
