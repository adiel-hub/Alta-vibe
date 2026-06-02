/**
 * Microsoft Outlook Calendar OAuth2 config (Microsoft identity platform /
 * Azure AD v2.0 endpoint).
 *
 * This file is the provider-specific half of the generic OAuth2 engine in
 * `lib/integrations/oauth/oauth2.ts` — it only declares the variation points
 * (endpoints, scopes, client-credential env vars). The shared engine owns
 * state signing, code exchange, refresh, and credential persistence.
 *
 * Microsoft specifics captured here:
 *   - Authorize / token endpoints are TENANT-scoped:
 *       https://login.microsoftonline.com/{tenant}/oauth2/v2.0/{authorize|token}
 *     We read the tenant lazily from MICROSOFT_OAUTH_TENANT (defaulting to
 *     "common" — the multi-tenant + personal-account endpoint), so it's
 *     resolved at request time rather than baked in at module load. Hence
 *     `endpoints` is a FUNCTION.
 *   - `offline_access` is REQUIRED for Microsoft to return a refresh_token;
 *     without it the engine's buildOAuthCredentials would throw on connect.
 *   - `openid email` let us decode the connected account's email from the
 *     id_token for display ("Connected as alice@contoso.com"). Microsoft
 *     surfaces it as `preferred_username`; emailFromIdToken handles that.
 *   - Calendars.ReadWrite covers getSchedule (free/busy) + event creation;
 *     OnlineMeetings.ReadWrite lets event creation attach a Teams link via
 *     isOnlineMeeting / onlineMeetingProvider:"teamsForBusiness".
 *   - No per-tenant instance_url — Graph's base is always graph.microsoft.com,
 *     so requiresInstanceUrlAtConnect is false and there's no instanceUrlFromToken.
 *   - response_mode:"query" so the code comes back on the query string the
 *     callback already reads.
 */
import type { OAuth2ProviderConfig } from "@/lib/integrations/oauth/oauth2";

export const OUTLOOK_CALENDAR_OAUTH_CONFIG: OAuth2ProviderConfig = {
  providerId: "outlook_calendar",
  clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
  clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
  endpoints: () => {
    const tenant = process.env.MICROSOFT_OAUTH_TENANT ?? "common";
    return {
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    };
  },
  scopes: [
    "offline_access",
    "openid",
    "email",
    "https://graph.microsoft.com/Calendars.ReadWrite",
    "https://graph.microsoft.com/OnlineMeetings.ReadWrite",
  ],
  authorizeParams: { response_mode: "query" },
  requiresInstanceUrlAtConnect: false,
};
