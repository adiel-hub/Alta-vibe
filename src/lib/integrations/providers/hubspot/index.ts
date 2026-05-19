import type { IntegrationProvider, ProviderRuntimeToolSpec } from "../types";
import { HUBSPOT_CONTACT_TOOLS } from "./tools/contacts";
import { HUBSPOT_COMPANY_TOOLS } from "./tools/companies";
import { HUBSPOT_DEAL_TOOLS } from "./tools/deals";
import { HUBSPOT_TICKET_TOOLS } from "./tools/tickets";
import { HUBSPOT_ENGAGEMENT_TOOLS } from "./tools/engagements";
import { HUBSPOT_METADATA_TOOLS } from "./tools/metadata";
import { HUBSPOT_ASSOCIATION_TOOLS } from "./tools/associations";

const HUBSPOT_TOOLS: ProviderRuntimeToolSpec[] = [
  ...HUBSPOT_CONTACT_TOOLS,
  ...HUBSPOT_COMPANY_TOOLS,
  ...HUBSPOT_DEAL_TOOLS,
  ...HUBSPOT_TICKET_TOOLS,
  ...HUBSPOT_ENGAGEMENT_TOOLS,
  ...HUBSPOT_METADATA_TOOLS,
  ...HUBSPOT_ASSOCIATION_TOOLS,
];

export const HUBSPOT_PROVIDER: IntegrationProvider = {
  id: "hubspot",
  name: "HubSpot",
  description: "CRM contacts, companies, deals, tickets, engagements.",
  icon: "/integrations/hubspot.png",
  base_api_url: "https://api.hubapi.com",
  oauth: {
    authorize_url: "https://app.hubspot.com/oauth/authorize",
    token_url: "https://api.hubapi.com/oauth/v1/token",
    scopes: [
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.companies.read",
      "crm.objects.companies.write",
      "crm.objects.deals.read",
      "crm.objects.deals.write",
    ],
  },
  runtime_tools: HUBSPOT_TOOLS,
};
