import { createOAuthStartRoute } from "@/lib/integrations/oauth/routeFactory";
import { SALESFORCE_OAUTH_CONFIG } from "@/lib/integrations/salesforce/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { POST } = createOAuthStartRoute(SALESFORCE_OAUTH_CONFIG);
