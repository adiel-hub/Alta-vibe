import type { IntegrationProvider } from "../types";
import { GOOGLE_CALENDAR_TOOLS } from "./tools/calendar";

/**
 * Google Calendar OAuth scopes:
 *   - calendar.events  — create / read events on the user's calendars
 *   - calendar.freebusy — busy-time lookup for check_availability
 *   - openid email     — so we can stash the connected account's email on
 *                        the integration row for display ("Connected as
 *                        alice@acme.com").
 */
export const GOOGLE_CALENDAR_PROVIDER: IntegrationProvider = {
  id: "google_calendar",
  name: "Google Calendar",
  description:
    "Check availability and book meetings on the user's primary Google Calendar.",
  icon: "/integrations/google-calendar.png",
  base_api_url: "https://www.googleapis.com",
  oauth: {
    authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.freebusy",
      "openid",
      "email",
    ],
  },
  runtime_tools: GOOGLE_CALENDAR_TOOLS,
};
