import type { IntegrationProvider } from "../types";
import { OUTLOOK_CALENDAR_TOOLS } from "./tools/calendar";

/**
 * Microsoft Outlook Calendar provider (Microsoft Graph v1.0).
 *
 * OAuth is the Microsoft identity platform (Azure AD v2.0). The variation
 * points (tenant-scoped endpoints, scopes, client-credential env vars) live
 * in `lib/integrations/outlook_calendar/auth.ts` as an OAuth2ProviderConfig
 * driven by the shared engine. The scopes mirrored here are for display /
 * documentation; the live authorize request reads them from that config.
 *
 *   - Calendars.ReadWrite — getSchedule (free/busy) + create events
 *   - OnlineMeetings.ReadWrite — attach a Teams link on create
 *   - offline_access — required for Microsoft to return a refresh_token
 *   - openid email — decode the connected account's email for display
 *
 * base_api_url is graph.microsoft.com; tool paths carry the /v1.0 prefix so
 * the proxy forwards to the stable Graph version.
 */
export const OUTLOOK_CALENDAR_PROVIDER: IntegrationProvider = {
  id: "outlook_calendar",
  name: "Microsoft Outlook Calendar",
  description:
    "Check free/busy availability and book meetings (with optional Microsoft Teams links) on the user's Outlook / Office 365 calendar.",
  icon: "/integrations/outlook.png",
  base_api_url: "https://graph.microsoft.com",
  oauth: {
    authorize_url:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "offline_access",
      "openid",
      "email",
      "https://graph.microsoft.com/Calendars.ReadWrite",
      "https://graph.microsoft.com/OnlineMeetings.ReadWrite",
    ],
  },
  runtime_tools: OUTLOOK_CALENDAR_TOOLS,
};
