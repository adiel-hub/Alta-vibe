import type { ProviderRuntimeToolSpec } from "../../types";
import { HUBSPOT_PROPERTIES_OBJECT, HUBSPOT_SEARCH_BODY_SCHEMA } from "../schemas";

export const HUBSPOT_COMPANY_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Companies ─────────────────────────────────────────────────────────
  {
    key: "create_company",
    name: "hubspot_create_company",
    description: "Create a new HubSpot company. Pass HubSpot property names (name, domain, industry, phone, city, etc.) in the properties map.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/companies",
    category: "Companies",
    body_schema: {
      type: "object",
      properties: { properties: HUBSPOT_PROPERTIES_OBJECT },
      required: ["properties"],
    },
  },
  {
    key: "search_companies",
    name: "hubspot_search_companies",
    description: "Search HubSpot companies by any property/operator combination (e.g. domain EQ acme.com, industry IN […]).",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/companies/search",
    category: "Companies",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
  {
    key: "get_company_by_id",
    name: "hubspot_get_company_by_id",
    description: "Fetch a HubSpot company by its record id.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/objects/companies/{companyId}",
    path_template: true,
    category: "Companies",
    query_schema: {
      properties: {
        companyId: { type: "string", description: "HubSpot company record id (substituted into the URL)." },
        properties: { type: "string", description: "Comma-separated list of property names to return." },
      },
      required: ["companyId"],
    },
  },
  {
    key: "update_company",
    name: "hubspot_update_company",
    description: "Update properties on an existing HubSpot company by id.",
    phase: "in_call",
    method: "PATCH",
    path: "/crm/v3/objects/companies/{companyId}",
    path_template: true,
    category: "Companies",
    body_schema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "HubSpot company record id (substituted into the URL)." },
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["companyId", "properties"],
    },
  },
];
