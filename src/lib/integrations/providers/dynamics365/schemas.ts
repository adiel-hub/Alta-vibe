// ── Microsoft Dynamics 365 (Dataverse Web API, OData v4) ────────────────────
// Body/query schemas reference the Dataverse Web API
// (https://learn.microsoft.com/power-apps/developer/data-platform/webapi/).
//
// Unlike HubSpot, Dataverse takes a record as a *flat* JSON object whose keys
// are the table's logical column names (e.g. firstname, emailaddress1,
// telephone1) — not a nested `properties` map. Typed values are sent with
// their native JSON type (numbers, booleans), and lookups are set with the
// `<navprop>@odata.bind` annotation pointing at "/<entityset>(<id>)". We model
// the record as an open object so the LLM can pass any column the customer's
// org defines, including custom (publisher-prefixed) columns.

/** A flat Dataverse record: column logical name → value. Open by design. */
export const DYNAMICS_RECORD_OBJECT = {
  type: "object",
  description:
    "Flat map of Dataverse column logical names → values for this table " +
    "(e.g. { firstname: 'Jane', lastname: 'Doe', emailaddress1: 'jane@acme.com' }). " +
    "Use the column's native JSON type (string/number/boolean). " +
    "To link a lookup, add a '<navigationProperty>@odata.bind' key whose value is " +
    "'/<entityset>(<recordId>)' — e.g. 'parentcustomerid_account@odata.bind': '/accounts(<guid>)'. " +
    "Custom columns use their publisher prefix (e.g. 'new_score').",
  additionalProperties: true,
} as const;

/**
 * Query-option schema for OData reads ($select / $filter / $top / $orderby).
 * Dataverse sends these as real URL query params, which the proxy forwards
 * verbatim, so the LLM produces the raw OData fragments here.
 */
export const DYNAMICS_QUERY_SCHEMA = {
  type: "object",
  properties: {
    $select: {
      type: "string",
      description:
        "Comma-separated column logical names to return (e.g. 'fullname,emailaddress1,telephone1'). " +
        "Always set this for performance — omitting it returns every column.",
    },
    $filter: {
      type: "string",
      description:
        "OData filter expression. String values are single-quoted and case-insensitive " +
        "(e.g. \"emailaddress1 eq 'jane@acme.com'\", \"statecode eq 0 and contains(fullname,'Doe')\"). " +
        "Operators: eq ne gt ge lt le and or not; functions: contains, startswith, endswith.",
    },
    $orderby: {
      type: "string",
      description:
        "Sort spec, e.g. 'createdon desc' or 'lastname asc,firstname asc'.",
    },
    $top: {
      type: "string",
      description: "Max number of rows to return (e.g. '5').",
    },
    $expand: {
      type: "string",
      description:
        "Related records to inline, e.g. 'primarycontactid($select=fullname)'.",
    },
  },
} as const;
