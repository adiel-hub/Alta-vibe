import type { IntegrationProvider, ProviderRuntimeToolSpec } from "../types";
import { DYNAMICS365_CONTACT_TOOLS } from "./tools/contacts";
import { DYNAMICS365_ACCOUNT_TOOLS } from "./tools/accounts";
import { DYNAMICS365_LEAD_TOOLS } from "./tools/leads";
import { DYNAMICS365_OPPORTUNITY_TOOLS } from "./tools/opportunities";
import { DYNAMICS365_ACTIVITY_TOOLS } from "./tools/activities";

const DYNAMICS365_TOOLS: ProviderRuntimeToolSpec[] = [
  ...DYNAMICS365_CONTACT_TOOLS,
  ...DYNAMICS365_ACCOUNT_TOOLS,
  ...DYNAMICS365_LEAD_TOOLS,
  ...DYNAMICS365_OPPORTUNITY_TOOLS,
  ...DYNAMICS365_ACTIVITY_TOOLS,
];

/**
 * Microsoft Dynamics 365 CRM via the Dataverse Web API (OData v4, /api/data/v9.2).
 *
 * OAuth runs through the Microsoft identity platform (see
 * src/lib/integrations/dynamics365/auth.ts). Endpoints/scopes are computed at
 * connect time — the tenant comes from MICROSOFT_OAUTH_TENANT and the Dataverse
 * resource scope is the user's org URL + /.default. The authorize/token URLs and
 * scopes below are the static fallbacks shown in the catalog UI; the live values
 * are produced by DYNAMICS365_OAUTH_CONFIG.
 *
 * base_api_url is a placeholder — every request runs against the per-tenant org
 * URL stored as the integration's `instance_url`, which the proxy uses as the
 * upstream base.
 */
export const DYNAMICS365_PROVIDER: IntegrationProvider = {
  id: "dynamics365",
  name: "Microsoft Dynamics 365",
  description: "CRM contacts, accounts, leads, opportunities, tasks, and call logging.",
  icon: "/integrations/dynamic365.png",
  base_api_url: "https://org.crm.dynamics.com",
  oauth: {
    authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "openid", "email"],
  },
  runtime_tools: DYNAMICS365_TOOLS,
};
