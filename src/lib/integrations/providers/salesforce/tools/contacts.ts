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
 * Salesforce Contact tools.
 *
 *   - lookup_contact (pre_call) — find the caller's Contact before we dial,
 *     via POST /parameterizedSearch/. The search term is the caller's email
 *     (falling back to the dialed number), scoped to the Contact object with
 *     the fields we want returned, including the related Account name. The
 *     flat `searchRecords` array is projected into caller_* dynamic variables
 *     so it slots into the same enrichment surface as the HubSpot lookup
 *     (caller_first_name, caller_last_name, caller_company, caller_email,
 *     caller_phone, caller_salesforce_contact_id).
 *   - create_contact / get_contact_by_id / update_contact / search_contacts —
 *     standard in-call CRUD over the sObject + query resources.
 */
export const SALESFORCE_CONTACT_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Contacts ──────────────────────────────────────────────────────────
  {
    key: "lookup_contact",
    name: "salesforce_lookup_contact",
    description:
      "Look up the caller's Salesforce Contact by email (or phone) before the call. " +
      "Exposes caller_first_name, caller_last_name, caller_company, caller_email, caller_phone, " +
      "caller_title, caller_salesforce_contact_id as dynamic variables.",
    phase: "pre_call",
    method: "POST",
    path: `/services/data/${V}/parameterizedSearch/`,
    category: "Contacts",
    body_schema: SALESFORCE_PARAMETERIZED_SEARCH_BODY_SCHEMA,
    build_body: (ctx) => {
      // Prefer email (exact, high-signal); fall back to the dialed number.
      const term = ctx.caller_email || ctx.to_number;
      if (!term) return null;
      return {
        q: term,
        sobjects: [
          {
            name: "Contact",
            // `Account.Name` is the related company; the rest are native
            // Contact fields. Salesforce returns relationship fields nested.
            fields: [
              "Id",
              "FirstName",
              "LastName",
              "Email",
              "Phone",
              "Title",
              "Account.Name",
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
      caller_company: "searchRecords.0.Account.Name",
      caller_salesforce_contact_id: "searchRecords.0.Id",
    },
    // Lets users map extra (incl. custom) Contact fields onto their own
    // dynamic variables — see ToolBinding.field_mappings. The mapped property
    // names are appended to the Contact `fields` array and projected from the
    // first matched record.
    field_mapping: {
      object: "Contact",
      request_properties_key: "fields",
      output_path_template: "searchRecords.0.{property}",
    },
    narrative: (_ctx, output) => {
      const o = output as
        | {
            searchRecords?: Array<{
              FirstName?: string;
              Title?: string;
              Account?: { Name?: string } | null;
            }>;
          }
        | null;
      const hit = o?.searchRecords?.[0];
      if (!hit) return null;
      const first = hit.FirstName ?? "";
      const title = hit.Title ?? "";
      const company = hit.Account?.Name ?? "";
      const parts: string[] = [];
      if (first && company) parts.push(`${first} from ${company}`);
      else if (first) parts.push(`${first}`);
      else if (company) parts.push(`Contact at ${company}`);
      if (title) parts.push(`title '${title}'`);
      return parts.length > 0 ? parts.join(", ") + "." : null;
    },
  },
  {
    key: "create_contact",
    name: "salesforce_create_contact",
    description:
      "Create a Salesforce Contact. Pass Salesforce API field names (FirstName, LastName, Email, Phone, Title, AccountId, …) in the fields map. " +
      "LastName is required by Salesforce. Returns { id, success, errors }.",
    phase: "in_call",
    method: "POST",
    path: `/services/data/${V}/sobjects/Contact`,
    category: "Contacts",
    body_schema: SALESFORCE_FIELDS_OBJECT,
  },
  {
    key: "get_contact_by_id",
    name: "salesforce_get_contact_by_id",
    description:
      "Fetch a Salesforce Contact by its record id. Pass `fields` to narrow the returned columns; omit to return all fields.",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/sobjects/Contact/{id}`,
    path_template: true,
    category: "Contacts",
    query_schema: SALESFORCE_GET_BY_ID_QUERY_SCHEMA,
  },
  {
    key: "update_contact",
    name: "salesforce_update_contact",
    description:
      "Update fields on an existing Salesforce Contact by id. Only pass the fields you want to change. Returns 204 No Content on success.",
    phase: "in_call",
    method: "PATCH",
    path: `/services/data/${V}/sobjects/Contact/{id}`,
    path_template: true,
    category: "Contacts",
    body_schema: SALESFORCE_UPDATE_BODY_SCHEMA,
  },
  {
    key: "search_contacts",
    name: "salesforce_search_contacts",
    description:
      "Search Salesforce Contacts with a SOQL query. Use for mid-conversation lookups beyond the pre-call enrichment. " +
      "Example q: \"SELECT Id, FirstName, LastName, Email FROM Contact WHERE Email = 'ada@acme.com' LIMIT 5\".",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/query/`,
    category: "Contacts",
    query_schema: SALESFORCE_SOQL_QUERY_SCHEMA,
  },
];
