import type { ProviderRuntimeToolSpec } from "../../types";
import {
  SALESFORCE_API_VERSION,
  SALESFORCE_FIELDS_OBJECT,
  SALESFORCE_GET_BY_ID_QUERY_SCHEMA,
  SALESFORCE_PARAMETERIZED_SEARCH_BODY_SCHEMA,
  SALESFORCE_SOQL_QUERY_SCHEMA,
  SALESFORCE_UPDATE_BODY_SCHEMA,
} from "../schemas";

const V = SALESFORCE_API_VERSION;

/**
 * Salesforce Lead tools. Mirrors the Contact set: a pre_call lookup that only
 * fires when the Contact lookup found nothing (it `needs` no Contact id, but
 * is lower priority so a matched Contact wins the shared caller_* variables),
 * plus in-call CRUD over the sObject + query resources.
 *
 * On a Lead, `Company` is a native top-level field (Leads aren't yet linked to
 * an Account), so the company variable maps to `Company` rather than the
 * Contact's `Account.Name`.
 */
export const SALESFORCE_LEAD_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Leads ─────────────────────────────────────────────────────────────
  {
    key: "lookup_lead",
    name: "salesforce_lookup_lead",
    description:
      "Look up the caller's Salesforce Lead by email (or phone) before the call. " +
      "Contributes caller_first_name, caller_last_name, caller_company, caller_email, caller_phone, " +
      "caller_title, caller_salesforce_lead_id — lower priority than the Contact lookup so a known Contact wins.",
    phase: "pre_call",
    method: "POST",
    path: `/services/data/${V}/parameterizedSearch/`,
    category: "Leads",
    // A matched Contact should win the shared caller_* variables; Leads are
    // colder records, so resolve collisions in the Contact lookup's favour.
    priority: -1,
    body_schema: SALESFORCE_PARAMETERIZED_SEARCH_BODY_SCHEMA,
    build_body: (ctx) => {
      const term = ctx.caller_email || ctx.to_number;
      if (!term) return null;
      return {
        q: term,
        sobjects: [
          {
            name: "Lead",
            fields: [
              "Id",
              "FirstName",
              "LastName",
              "Email",
              "Phone",
              "Title",
              "Company",
              "Status",
            ],
            limit: 1,
          },
        ],
        overallLimit: 1,
      };
    },
    output_aliases: {
      caller_first_name: "searchRecords.0.FirstName",
      caller_last_name: "searchRecords.0.LastName",
      caller_email: "searchRecords.0.Email",
      caller_phone: "searchRecords.0.Phone",
      caller_title: "searchRecords.0.Title",
      caller_company: "searchRecords.0.Company",
      caller_salesforce_lead_id: "searchRecords.0.Id",
    },
    field_mapping: {
      object: "Lead",
      request_properties_key: "fields",
      output_path_template: "searchRecords.0.{property}",
    },
    narrative: (_ctx, output) => {
      const o = output as
        | { searchRecords?: Array<{ FirstName?: string; Company?: string; Status?: string }> }
        | null;
      const hit = o?.searchRecords?.[0];
      if (!hit) return null;
      const first = hit.FirstName ?? "";
      const company = hit.Company ?? "";
      const status = hit.Status ?? "";
      const parts: string[] = [];
      if (first && company) parts.push(`Lead ${first} at ${company}`);
      else if (first) parts.push(`Lead ${first}`);
      else if (company) parts.push(`Lead at ${company}`);
      if (status) parts.push(`status '${status}'`);
      return parts.length > 0 ? parts.join(", ") + "." : null;
    },
  },
  {
    key: "create_lead",
    name: "salesforce_create_lead",
    description:
      "Create a Salesforce Lead. Pass Salesforce API field names (FirstName, LastName, Company, Email, Phone, Title, Status, …) in the fields map. " +
      "LastName and Company are required by Salesforce. Returns { id, success, errors }.",
    phase: "in_call",
    method: "POST",
    path: `/services/data/${V}/sobjects/Lead`,
    category: "Leads",
    body_schema: SALESFORCE_FIELDS_OBJECT,
  },
  {
    key: "get_lead_by_id",
    name: "salesforce_get_lead_by_id",
    description:
      "Fetch a Salesforce Lead by its record id. Pass `fields` to narrow the returned columns; omit to return all fields.",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/sobjects/Lead/{id}`,
    path_template: true,
    category: "Leads",
    query_schema: SALESFORCE_GET_BY_ID_QUERY_SCHEMA,
  },
  {
    key: "update_lead",
    name: "salesforce_update_lead",
    description:
      "Update fields on an existing Salesforce Lead by id (e.g. set Status). Only pass the fields you want to change. Returns 204 No Content on success.",
    phase: "in_call",
    method: "PATCH",
    path: `/services/data/${V}/sobjects/Lead/{id}`,
    path_template: true,
    category: "Leads",
    body_schema: SALESFORCE_UPDATE_BODY_SCHEMA,
  },
  {
    key: "search_leads",
    name: "salesforce_search_leads",
    description:
      "Search Salesforce Leads with a SOQL query. " +
      "Example q: \"SELECT Id, FirstName, LastName, Company, Status FROM Lead WHERE Email = 'ada@acme.com' LIMIT 5\".",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/query/`,
    category: "Leads",
    query_schema: SALESFORCE_SOQL_QUERY_SCHEMA,
  },
];
