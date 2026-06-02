import type { ProviderRuntimeToolSpec } from "../../types";
import { DYNAMICS_RECORD_OBJECT, DYNAMICS_QUERY_SCHEMA } from "../schemas";

/**
 * Dynamics 365 (Dataverse) lead tools.
 *
 * Entity set: `leads` (EntityType `lead`, primary key `leadid`).
 * Useful columns: subject (topic), firstname, lastname, companyname,
 * emailaddress1, telephone1, jobtitle, leadsourcecode, leadqualitycode.
 */
export const DYNAMICS365_LEAD_TOOLS: ProviderRuntimeToolSpec[] = [
  {
    key: "create_lead",
    name: "dynamics365_create_lead",
    description:
      "Create a new Dynamics 365 lead. Pass Dataverse column logical names " +
      "(subject, firstname, lastname, companyname, emailaddress1, telephone1, " +
      "jobtitle, …) as a flat JSON object. `subject` is the lead topic and is " +
      "effectively required by most orgs.",
    phase: "in_call",
    method: "POST",
    path: "/api/data/v9.2/leads",
    category: "Leads",
    body_schema: DYNAMICS_RECORD_OBJECT,
  },
  {
    key: "search_leads",
    name: "dynamics365_search_leads",
    description:
      "Search Dynamics 365 leads with an OData $filter/$select query. Returns the " +
      "matching rows in a `value` array.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/leads",
    category: "Leads",
    query_schema: DYNAMICS_QUERY_SCHEMA,
  },
  {
    key: "get_lead_by_id",
    name: "dynamics365_get_lead_by_id",
    description:
      "Fetch a Dynamics 365 lead by its leadid (GUID). Use $select to limit the " +
      "columns returned.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/leads({leadId})",
    path_template: true,
    category: "Leads",
    query_schema: {
      type: "object",
      properties: {
        leadId: {
          type: "string",
          description: "Lead GUID (leadid), substituted into the URL.",
        },
        $select: {
          type: "string",
          description: "Comma-separated column logical names to return.",
        },
      },
      required: ["leadId"],
    },
  },
  {
    key: "update_lead",
    name: "dynamics365_update_lead",
    description:
      "Update columns on an existing Dynamics 365 lead by leadid. Only pass the " +
      "columns you want to change.",
    phase: "in_call",
    method: "PATCH",
    path: "/api/data/v9.2/leads({leadId})",
    path_template: true,
    category: "Leads",
    body_schema: {
      type: "object",
      description:
        "Pass `leadId` (the GUID to update) plus the column logical names to change as " +
        "sibling keys. `leadId` is consumed by the URL and not written.",
      properties: {
        leadId: {
          type: "string",
          description: "Lead GUID (leadid), substituted into the URL.",
        },
      },
      required: ["leadId"],
      additionalProperties: true,
    },
  },
];
