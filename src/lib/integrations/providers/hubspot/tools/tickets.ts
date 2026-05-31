import type { ProviderRuntimeToolSpec } from "../../types";
import { HUBSPOT_PROPERTIES_OBJECT, HUBSPOT_SEARCH_BODY_SCHEMA } from "../schemas";

export const HUBSPOT_TICKET_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Tickets ───────────────────────────────────────────────────────────
  {
    key: "create_ticket",
    name: "hubspot_create_ticket",
    description: "Create a HubSpot support ticket from the current call. Required properties: subject, hs_pipeline, hs_pipeline_stage. Commonly include hs_ticket_priority and content.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/tickets",
    category: "Tickets",
    body_schema: {
      type: "object",
      properties: { properties: HUBSPOT_PROPERTIES_OBJECT },
      required: ["properties"],
    },
  },
  {
    key: "update_ticket",
    name: "hubspot_update_ticket",
    description: "Update properties on an existing HubSpot ticket by id (status, priority, owner, custom fields).",
    phase: "in_call",
    method: "PATCH",
    path: "/crm/v3/objects/tickets/{ticketId}",
    path_template: true,
    category: "Tickets",
    body_schema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "HubSpot ticket record id (substituted into the URL)." },
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["ticketId", "properties"],
    },
  },
  {
    key: "search_tickets",
    name: "hubspot_search_tickets",
    description: "Search HubSpot tickets by any property (e.g. associated contact id, hs_pipeline_stage, hs_ticket_priority).",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/tickets/search",
    category: "Tickets",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
];
