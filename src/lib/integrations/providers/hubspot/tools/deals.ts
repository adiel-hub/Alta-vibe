import type { ProviderRuntimeToolSpec } from "../../types";
import { HUBSPOT_PROPERTIES_OBJECT, HUBSPOT_SEARCH_BODY_SCHEMA } from "../schemas";

export const HUBSPOT_DEAL_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Pre-call: get open deals for the caller ──────────────────────────
  // Demonstrates wave 2 — depends on caller_hubspot_contact_id from
  // hubspot_lookup_contact running first.
  {
    key: "get_open_deals_for_caller",
    name: "hubspot_get_open_deals_for_caller",
    description:
      "Fetch the caller's open HubSpot deals so the agent can reference them. Depends on hubspot_lookup_contact running first (needs caller_hubspot_contact_id). Emits deal_count, deal_top_name, deal_top_amount, deal_top_stage.",
    phase: "pre_call",
    method: "POST",
    path: "/crm/v3/objects/deals/search",
    category: "Deals",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
    needs: ["caller_hubspot_contact_id"],
    build_body: (_ctx, prior) => {
      const contactId = prior.caller_hubspot_contact_id;
      if (!contactId) return null;
      return {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "associations.contact",
                operator: "EQ",
                value: contactId,
              },
              { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
            ],
          },
        ],
        properties: ["dealname", "amount", "dealstage", "pipeline"],
        sorts: ["amount"],
        limit: 5,
      };
    },
    output_aliases: {
      deal_count: "total",
      deal_top_name: "results.0.properties.dealname",
      deal_top_amount: "results.0.properties.amount",
      deal_top_stage: "results.0.properties.dealstage",
    },
    narrative: (_ctx, output) => {
      const o = output as { total?: number; results?: Array<{ properties?: Record<string, string> }> } | null;
      if (!o?.results || o.results.length === 0) return null;
      const top = o.results[0]?.properties ?? {};
      const count = o.total ?? o.results.length;
      const parts: string[] = [];
      if (count > 0) parts.push(`${count} open deal${count === 1 ? "" : "s"}`);
      if (top.dealname && top.amount) parts.push(`largest: ${top.dealname} ($${top.amount})`);
      else if (top.dealname) parts.push(`largest: ${top.dealname}`);
      return parts.length > 0 ? parts.join(" — ") + "." : null;
    },
  },
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
