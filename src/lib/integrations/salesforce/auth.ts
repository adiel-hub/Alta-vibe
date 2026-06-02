/**
 * Salesforce CRM OAuth2 config — consumed by the generic OAuth2 engine
 * (`@/lib/integrations/oauth/oauth2`) and the route factories. Salesforce
 * uses the OAuth 2.0 Web Server (authorization-code) flow against a
 * "Connected App".
 *
 * Salesforce specifics captured here:
 *   - Static authorize/token endpoints on login.salesforce.com (production /
 *     Developer Edition orgs). Sandboxes use test.salesforce.com, but the
 *     per-org API base we actually call is derived from the token response's
 *     `instance_url`, so the login host only governs the auth dance.
 *   - `instanceUrlFromToken: "instance_url"` — Salesforce returns the org's
 *     API base (e.g. https://acme.my.salesforce.com) in the token response.
 *     We persist it and the proxy uses it as the upstream base, overriding
 *     the provider's fallback base_api_url.
 *   - `prompt: "login consent"` in the authorize params guarantees a
 *     refresh_token is issued (the `refresh_token` scope must also be granted
 *     on the Connected App).
 *   - `defaultExpiresInSeconds: 7200` — Salesforce frequently omits
 *     `expires_in` on the token response; default the access-token TTL to the
 *     common 2-hour session timeout so the proxy refreshes proactively.
 *   - `requiresInstanceUrlAtConnect: false` — unlike Dynamics, the user never
 *     types their org URL; it comes back with the tokens.
 *
 * Docs:
 *   https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_understanding_authentication.htm
 */
import type { OAuth2ProviderConfig } from "@/lib/integrations/oauth/oauth2";

export const SALESFORCE_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerId: "salesforce",
  clientIdEnv: "SALESFORCE_OAUTH_CLIENT_ID",
  clientSecretEnv: "SALESFORCE_OAUTH_CLIENT_SECRET",
  endpoints: {
    authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
  },
  scopes: ["api", "refresh_token", "openid", "email"],
  // `prompt=login consent` forces re-consent so a refresh_token is always
  // returned (Salesforce otherwise reuses an existing approval and may omit it).
  authorizeParams: { prompt: "login consent" },
  // The token response carries the per-org API base — store it and let the
  // proxy use it as the upstream base for every sObject/query call.
  instanceUrlFromToken: "instance_url",
  // Salesforce often omits expires_in; default to the typical 2-hour session.
  defaultExpiresInSeconds: 7200,
  // The org URL comes back with the tokens; the user never supplies it.
  requiresInstanceUrlAtConnect: false,
};
