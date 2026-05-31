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
    description: "Look up a HubSpot contact by phone or email; exposes caller_first_name, caller_last_name, caller_company, caller_lifecycle_stage, caller_email, caller_phone, caller_last_contacted, caller_open_deal_count, caller_hubspot_contact_id as dynamic variables.",
    phase: "pre_call",
    method: "POST",
    path: "/crm/v3/objects/contacts/search",
    category: "Contacts",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
    build_body: (ctx) => {
      const filterGroups: Array<{
        filters: Array<{ propertyName: string; operator: string; value: string }>;
      }> = [];
      if (ctx.caller_email) {
        filterGroups.push({
          filters: [{ propertyName: "email", operator: "EQ", value: ctx.caller_email }],
        });
      }
      if (ctx.to_number) {
        filterGroups.push({
          filters: [{ propertyName: "phone", operator: "EQ", value: ctx.to_number }],
        });
      }
      if (filterGroups.length === 0) return null;
      return {
        filterGroups,
        properties: [
          "firstname",
          "lastname",
          "company",
          "lifecyclestage",
          "email",
          "phone",
          "notes_last_contacted",
          "num_associated_deals",
        ],
        limit: 1,
      };
    },
    output_aliases: {
      caller_first_name: "results.0.properties.firstname",
      caller_last_name: "results.0.properties.lastname",
      caller_company: "results.0.properties.company",
      caller_lifecycle_stage: "results.0.properties.lifecyclestage",
      caller_email: "results.0.properties.email",
      caller_phone: "results.0.properties.phone",
      caller_last_contacted: "results.0.properties.notes_last_contacted",
      caller_open_deal_count: "results.0.properties.num_associated_deals",
      caller_hubspot_contact_id: "results.0.id",
    },
    narrative: (_ctx, output) => {
      const o = output as { results?: Array<{ properties?: Record<string, string> }> } | null;
      const hit = o?.results?.[0];
      if (!hit?.properties) return null;
      const p = hit.properties;
      const first = p.firstname ?? "";
      const company = p.company ?? "";
      const stage = p.lifecyclestage ?? "";
      const parts: string[] = [];
      if (first && company) parts.push(`${first} from ${company}`);
      else if (first) parts.push(`${first}`);
      else if (company) parts.push(`Contact at ${company}`);
      if (stage) parts.push(`lifecycle stage '${stage}'`);
      return parts.length > 0 ? parts.join(", ") + "." : null;
    },
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
