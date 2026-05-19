import type { ProviderRuntimeToolSpec } from "../../types";
import { HUBSPOT_PROPERTIES_OBJECT, HUBSPOT_SEARCH_BODY_SCHEMA } from "../schemas";

export const HUBSPOT_DEAL_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Deals ─────────────────────────────────────────────────────────────
  {
    key: "create_deal",
    name: "hubspot_create_deal",
    description: "Create a HubSpot deal. Required properties typically include dealname, pipeline, dealstage; commonly also amount, closedate, hubspot_owner_id.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/deals",
    category: "Deals",
    body_schema: {
      type: "object",
      properties: { properties: HUBSPOT_PROPERTIES_OBJECT },
      required: ["properties"],
    },
  },
  {
    key: "get_deal_by_id",
    name: "hubspot_get_deal_by_id",
    description: "Fetch a HubSpot deal by its record id.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/objects/deals/{dealId}",
    path_template: true,
    category: "Deals",
    query_schema: {
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id (substituted into the URL)." },
        properties: { type: "string", description: "Comma-separated list of property names to return." },
      },
      required: ["dealId"],
    },
  },
  {
    key: "update_deal",
    name: "hubspot_update_deal",
    description: "Update properties on an existing HubSpot deal by id (amount, dealname, closedate, custom fields, etc.).",
    phase: "in_call",
    method: "PATCH",
    path: "/crm/v3/objects/deals/{dealId}",
    path_template: true,
    category: "Deals",
    body_schema: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id (substituted into the URL)." },
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["dealId", "properties"],
    },
  },
  {
    key: "move_deal_stage",
    name: "hubspot_move_deal_stage",
    description: "Move a HubSpot deal to a different pipeline stage. Pass the deal id and the target dealstage id (use list_deal_pipelines to discover stage ids).",
    phase: "post_call",
    method: "PATCH",
    path: "/crm/v3/objects/deals/{dealId}",
    path_template: true,
    category: "Deals",
    body_schema: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id (substituted into the URL)." },
        properties: {
          type: "object",
          properties: {
            dealstage: { type: "string", description: "Target dealstage id." },
          },
          required: ["dealstage"],
        },
      },
      required: ["dealId", "properties"],
    },
  },
  {
    key: "search_deals",
    name: "hubspot_search_deals",
    description: "Search HubSpot deals by any property (e.g. associated contact id, dealstage, amount range, hubspot_owner_id).",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/deals/search",
    category: "Deals",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
  {
    key: "list_deal_pipelines",
    name: "hubspot_list_deal_pipelines",
    description: "List all HubSpot deal pipelines and their stages. Useful before creating deals or moving them between stages.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/pipelines/deals",
    category: "Deals",
  },
];
