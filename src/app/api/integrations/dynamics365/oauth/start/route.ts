import { createOAuthStartRoute } from "@/lib/integrations/oauth/routeFactory";
import { DYNAMICS365_OAUTH_CONFIG } from "@/lib/integrations/dynamics365/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { POST } = createOAuthStartRoute(DYNAMICS365_OAUTH_CONFIG);
