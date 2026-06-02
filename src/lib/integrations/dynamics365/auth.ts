/**
 * Microsoft Dynamics 365 (Dataverse) OAuth2 config.
 *
 * Auth flows through the Microsoft identity platform (Azure AD). Two things
 * make Dynamics different from a static-endpoint provider like Google:
 *
 *   1. Endpoints are tenant-scoped. The `{tenant}` segment of the v2.0
 *      authorize/token URLs is read from MICROSOFT_OAUTH_TENANT (defaulting
 *      to "common" — the multi-tenant endpoint that lets any work/school
 *      account sign in). We read it lazily inside `endpoints` so a missing
 *      env var doesn't throw at module-load.
 *
 *   2. The Dataverse resource scope is the customer's org URL plus
 *      `/.default` (e.g. https://contoso.crm.dynamics.com/.default). That URL
 *      is supplied by the user at connect time (requiresInstanceUrlAtConnect)
 *      and signed into the OAuth state, so `scopes` is a function of the
 *      connect-time instance context. When the org URL is absent we fall back
 *      to the bare OIDC set — the start handler enforces presence before we
 *      ever reach the resource-scoped path.
 *
 * `offline_access` is required for Microsoft to return a refresh_token; the
 * generic engine refreshes the access token in-place and rotates the
 * refresh_token when Microsoft issues a new one.
 *
 * The org URL itself is the per-tenant API base (instance_url). It comes from
 * the user (via the signed state → buildOAuthCredentials opts.instanceUrl),
 * not from the token response — so instanceUrlFromToken stays undefined.
 */
import type { OAuth2ProviderConfig } from "@/lib/integrations/oauth/oauth2";

const OIDC_SCOPES = ["offline_access", "openid", "email"];

export const DYNAMICS365_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerId: "dynamics365",
  clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
  clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
  endpoints: () => {
    const tenant = process.env.MICROSOFT_OAUTH_TENANT ?? "common";
    return {
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    };
  },
  scopes: (ctx) => {
    // Dataverse exposes a single delegated resource scope: <orgUrl>/.default.
    // Without the org URL we can't build it, so request only the OIDC scopes
    // (the start handler blocks the connect when the org URL is missing).
    if (!ctx.instanceUrl) return OIDC_SCOPES;
    return [...OIDC_SCOPES, `${ctx.instanceUrl.replace(/\/$/, "")}/.default`];
  },
  // Microsoft v2.0 returns the auth code on the query string by default; being
  // explicit keeps the popup/redirect handling deterministic.
  authorizeParams: { response_mode: "query" },
  // The org URL is user-supplied at connect time, not carried by the token
  // response — so there's no instanceUrlFromToken field to read.
  requiresInstanceUrlAtConnect: true,
};
