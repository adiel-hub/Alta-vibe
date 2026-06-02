/**
 * Provider → access-token resolver dispatch for the integration proxy.
 *
 * Replaces the proxy's hard-coded `if (provider === "google_calendar")`
 * branch. Resolution order:
 *   1. Google Calendar → its bespoke resolver (kept for back-compat).
 *   2. Any provider with an OAuth2 config (Salesforce, Dynamics, Outlook, …)
 *      → the generic refresh-in-place resolver.
 *   3. Everything else (HubSpot PAT, Slack bot token) → decrypt the stored
 *      access_token directly.
 */
import { findWorkspaceIntegration } from "@/lib/integrations/store";
import { decryptToken } from "@/lib/integrations/tokens";
import { getValidGoogleToken } from "@/lib/integrations/google/auth";
import { getValidOAuthToken } from "./oauth2";
import { OAUTH2_CONFIGS } from "./configs";

export async function resolveProviderToken(
  provider: string,
  agentId: string,
): Promise<string> {
  if (provider === "google_calendar") {
    return getValidGoogleToken(agentId);
  }

  const cfg = OAUTH2_CONFIGS[provider];
  if (cfg) {
    return getValidOAuthToken(cfg);
  }

  // Static-credential providers: decrypt the stored access_token.
  const doc = await findWorkspaceIntegration(provider);
  if (!doc) {
    throw new Error(`${provider} is not connected in this workspace.`);
  }
  const encrypted = (doc.credentials as { access_token?: unknown }).access_token;
  if (typeof encrypted !== "string") {
    throw new Error(`${provider} credentials are missing an access token.`);
  }
  return decryptToken(encrypted);
}
