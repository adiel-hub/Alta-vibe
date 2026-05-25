// ── HubSpot ────────────────────────────────────────────────────────────────
// Body schemas reference the HubSpot v3 CRM API. `properties` is a flat
// string-map on the wire; we declare it as an object with HubSpot's most
// useful property keys but keep `additionalProperties` so the LLM can pass
// custom property names too.

export const HUBSPOT_PROPERTIES_OBJECT = {
  type: "object",
  description:
    "Flat string-map of HubSpot property names → values. HubSpot stores all property values as strings on the wire.",
  additionalProperties: { type: "string" },
} as const;

export const HUBSPOT_SEARCH_BODY_SCHEMA = {
  type: "object",
  properties: {
    filterGroups: {
      type: "array",
      description:
        "Array of filter groups, OR'd together. Each group's filters are AND'd. Example: [{filters:[{propertyName:'email',operator:'EQ',value:'a@b.com'}]}].",
      items: {
        type: "object",
        properties: {
          filters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                propertyName: { type: "string", description: "HubSpot property to filter on (e.g. 'email', 'phone', 'firstname')." },
                operator: {
                  type: "string",
                  description:
                    "EQ, NEQ, LT, LTE, GT, GTE, BETWEEN, IN, NOT_IN, HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN, NOT_CONTAINS_TOKEN.",
                },
                value: { type: "string", description: "Comparison value (or stringified array for IN/NOT_IN)." },
              },
              required: ["propertyName", "operator"],
            },
          },
        },
        required: ["filters"],
      },
    },
    properties: {
      type: "array",
      description: "HubSpot property names to return on each match.",
      items: { type: "string", description: "HubSpot property name (e.g. 'email', 'firstname', 'lastname')." },
    },
    limit: { type: "integer", description: "Max records to return (default 10, max 100)." },
    after: { type: "string", description: "Pagination cursor from a previous response." },
    sorts: {
      type: "array",
      description: "Optional list of property-name/direction pairs.",
      items: { type: "string", description: "Sort spec — either a HubSpot property name (ascending) or '-propertyName' for descending." },
    },
  },
} as const;
