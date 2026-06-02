// ── Salesforce ───────────────────────────────────────────────────────────────
// Reusable JSON-schemas for the Salesforce REST API (v60.0). Salesforce
// records are flat field maps keyed by API field name (FirstName, LastName,
// Email, Phone, Company, AccountId, …). Unlike HubSpot, Salesforce field
// values are *typed* on the wire (strings, numbers, booleans, ISO dates), so
// the fields map allows any scalar — we don't coerce everything to string.
//
// Docs:
//   Create a record:     /services/data/v60.0/sobjects/{SObject}            (POST)
//   Get a record by id:  /services/data/v60.0/sobjects/{SObject}/{id}       (GET, ?fields=)
//   Update a record:     /services/data/v60.0/sobjects/{SObject}/{id}       (PATCH, 204)
//   SOQL query:          /services/data/v60.0/query/?q=SELECT+...           (GET)
//   Parameterized search:/services/data/v60.0/parameterizedSearch/          (POST body)
//   https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_list.htm

/** Current REST API version. Bump in one place when Salesforce advances. */
export const SALESFORCE_API_VERSION = "v60.0";

/**
 * Flat map of Salesforce API field names → values for create/update bodies.
 * Salesforce stores typed values (text, number, boolean, date), so we allow
 * any scalar rather than forcing strings like HubSpot does. The LLM passes
 * the API field name exactly as it appears in the org (custom fields end in
 * `__c`).
 */
export const SALESFORCE_FIELDS_OBJECT = {
  type: "object",
  description:
    "Flat map of Salesforce API field names → values (e.g. { FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@acme.com' }). " +
    "Use exact Salesforce API field names; custom fields end in '__c'. Values are typed (string, number, boolean, ISO-8601 date).",
  additionalProperties: {
    type: ["string", "number", "boolean", "null"],
    description: "Field value, typed per the field's Salesforce data type.",
  },
} as const;

/**
 * Body schema for POST /parameterizedSearch/. Salesforce executes a simple
 * SOSL-style search across the requested sObjects and returns a flat
 * `searchRecords` array. `q` is the literal search term (e.g. an email or
 * phone number); `sobjects` scopes the search and selects returned fields.
 *   https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_search_parameterized_post.htm
 */
export const SALESFORCE_PARAMETERIZED_SEARCH_BODY_SCHEMA = {
  type: "object",
  properties: {
    q: {
      type: "string",
      description:
        "Search term (min 2 chars). Matches across the requested sobjects' searchable fields — e.g. an email address or phone number.",
    },
    fields: {
      type: "array",
      description:
        "Default fields to return on every matched record when an sobject doesn't list its own `fields`.",
      items: { type: "string", description: "Salesforce API field name (e.g. 'Id', 'Name')." },
    },
    sobjects: {
      type: "array",
      description:
        "Objects to search. Each entry scopes the search to one object and selects its returned fields.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "sObject API name (e.g. 'Contact', 'Lead', 'Account')." },
          fields: {
            type: "array",
            description: "Fields to return for this object's matches.",
            items: { type: "string", description: "Salesforce API field name." },
          },
          limit: { type: "integer", description: "Max records to return for this object." },
        },
        required: ["name"],
      },
    },
    overallLimit: {
      type: "integer",
      description: "Maximum total number of records returned across all sobjects.",
    },
    defaultLimit: {
      type: "integer",
      description: "Default per-object record limit when an sobject omits its own `limit`.",
    },
  },
  required: ["q"],
} as const;

/**
 * Query-params schema for GET /query/. The whole SOQL statement rides in the
 * single `q` param; the proxy forwards it as an actual URL query parameter.
 *   https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_query.htm
 */
export const SALESFORCE_SOQL_QUERY_SCHEMA = {
  type: "object",
  properties: {
    q: {
      type: "string",
      description:
        "Complete SOQL statement, e.g. \"SELECT Id, Name, Email FROM Contact WHERE Email = 'ada@acme.com' LIMIT 5\". " +
        "Single-quote string literals; escape embedded quotes per SOQL rules.",
    },
  },
  required: ["q"],
} as const;

/**
 * Body schema for PATCH /sobjects/{SObject}/{id}. Salesforce expects the
 * update body to be the *flat* field map at the top level — there is no
 * wrapper key. We surface `id` as a top-level property so the proxy's
 * path-template substitution can lift it into the URL; every other top-level
 * key is treated as a Salesforce field to update. After substitution the
 * forwarded body is exactly the flat field map Salesforce wants (id stripped).
 */
export const SALESFORCE_UPDATE_BODY_SCHEMA = {
  type: "object",
  description:
    "Top-level Salesforce API field names → new values. `id` names the record to update (lifted into the URL) and is not sent as a field. " +
    "Example: { id: '003...', Title: 'VP Sales', Phone: '+14155550123' }.",
  properties: {
    id: { type: "string", description: "Salesforce record id to update (substituted into the URL, not sent as a field)." },
  },
  required: ["id"],
  additionalProperties: {
    type: ["string", "number", "boolean", "null"],
    description: "Field value, typed per the field's Salesforce data type.",
  },
} as const;

/**
 * Query-params schema for GET /sobjects/{SObject}/{id}. `id` is lifted into
 * the path by the proxy (path_template); `fields` optionally narrows the
 * returned columns.
 */
export const SALESFORCE_GET_BY_ID_QUERY_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Salesforce 15- or 18-char record id (substituted into the URL)." },
    fields: {
      type: "string",
      description: "Optional comma-separated list of API field names to return (e.g. 'FirstName,LastName,Email').",
    },
  },
  required: ["id"],
} as const;
