import type { ProviderRuntimeToolSpec } from "../../types";
import { HUBSPOT_PROPERTIES_OBJECT, HUBSPOT_SEARCH_BODY_SCHEMA } from "../schemas";

export const HUBSPOT_CONTACT_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Contacts ──────────────────────────────────────────────────────────
  {
    key: "create_contact",
    name: "hubspot_create_contact",
    description: "Create a new HubSpot contact. Pass HubSpot property names (firstname, lastname, email, phone, company, lifecyclestage, etc.) in the properties map.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/contacts",
    category: "Contacts",
    body_schema: {
      type: "object",
      properties: {
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["properties"],
    },
  },
  {
    key: "lookup_contact",
    name: "hubspot_lookup_contact",
    description: "Look up a HubSpot contact by phone or email and return profile + recent activity. Pass either email or phone in the filterGroups.",
    phase: "pre_call",
    method: "POST",
    path: "/crm/v3/objects/contacts/search",
    default_install: true,
    category: "Contacts",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
  {
    key: "search_contacts",
    name: "hubspot_search_contacts",
    description: "Generic HubSpot contact search by any property/operator combination. Use for mid-conversation lookups beyond the pre-call enrichment.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/contacts/search",
    category: "Contacts",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
  {
    key: "get_contact_by_id",
    name: "hubspot_get_contact_by_id",
    description: "Fetch a HubSpot contact by its record id. Returns all default properties plus any requested ones.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/objects/contacts/{contactId}",
    path_template: true,
    category: "Contacts",
    query_schema: {
      properties: {
        contactId: { type: "string", description: "HubSpot contact record id (substituted into the URL)." },
        properties: { type: "string", description: "Comma-separated list of property names to return." },
      },
      required: ["contactId"],
    },
  },
  {
    key: "update_contact",
    name: "hubspot_update_contact",
    description: "Update properties on an existing HubSpot contact by id. Only pass properties you want to change.",
    phase: "in_call",
    method: "PATCH",
    path: "/crm/v3/objects/contacts/{contactId}",
    path_template: true,
    category: "Contacts",
    body_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "HubSpot contact record id (substituted into the URL)." },
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["contactId", "properties"],
    },
  },
  {
    key: "archive_contact",
    name: "hubspot_archive_contact",
    description: "Archive (soft-delete) a HubSpot contact by id. Reversible from the HubSpot UI for 90 days.",
    phase: "post_call",
    method: "DELETE",
    path: "/crm/v3/objects/contacts/{contactId}",
    path_template: true,
    category: "Contacts",
    query_schema: {
      properties: {
        contactId: { type: "string", description: "HubSpot contact record id (substituted into the URL)." },
      },
      required: ["contactId"],
    },
  },
];
