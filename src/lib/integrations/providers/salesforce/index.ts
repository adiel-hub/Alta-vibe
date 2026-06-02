import type { IntegrationProvider, ProviderRuntimeToolSpec } from "../types";
import { SALESFORCE_CONTACT_TOOLS } from "./tools/contacts";
import { SALESFORCE_LEAD_TOOLS } from "./tools/leads";
import { SALESFORCE_ACCOUNT_TOOLS } from "./tools/accounts";
import { SALESFORCE_OPPORTUNITY_TOOLS } from "./tools/opportunities";
import { SALESFORCE_CASE_TOOLS } from "./tools/cases";
import { SALESFORCE_TASK_TOOLS } from "./tools/tasks";

const SALESFORCE_TOOLS: ProviderRuntimeToolSpec[] = [
  ...SALESFORCE_CONTACT_TOOLS,
  ...SALESFORCE_LEAD_TOOLS,
  ...SALESFORCE_ACCOUNT_TOOLS,
  ...SALESFORCE_OPPORTUNITY_TOOLS,
  ...SALESFORCE_CASE_TOOLS,
  ...SALESFORCE_TASK_TOOLS,
];

/**
 * Salesforce CRM provider.
 *
 * OAuth: OAuth 2.0 Web Server flow against a Connected App (see
 * `@/lib/integrations/salesforce/auth`). The token exchange returns the org's
 * per-tenant API base in `instance_url`; we persist it and the proxy uses it
 * as the upstream base, so `base_api_url` below is only a fallback for logging
 * / display before the first connect.
 *
 * Scopes:
 *   - api          — REST access to the org's sObjects + query/search.
 *   - refresh_token — long-lived offline access (the proxy refreshes in-place).
 *   - openid email — so we can stash the connected account's email for display.
 */
export const SALESFORCE_PROVIDER: IntegrationProvider = {
  id: "salesforce",
  name: "Salesforce",
  description: "CRM contacts, leads, accounts, opportunities, cases, tasks.",
  icon: "/integrations/salesforce.png",
  // Fallback base only — the per-org `instance_url` from the token response
  // overrides this at runtime in the proxy.
  base_api_url: "https://login.salesforce.com",
  oauth: {
    authorize_url: "https://login.salesforce.com/services/oauth2/authorize",
    token_url: "https://login.salesforce.com/services/oauth2/token",
    scopes: ["api", "refresh_token", "openid", "email"],
  },
  runtime_tools: SALESFORCE_TOOLS,
};
