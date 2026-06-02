import { createOAuthStartRoute } from "@/lib/integrations/oauth/routeFactory";
import { OUTLOOK_CALENDAR_OAUTH_CONFIG } from "@/lib/integrations/outlook_calendar/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { POST } = createOAuthStartRoute(OUTLOOK_CALENDAR_OAUTH_CONFIG);
