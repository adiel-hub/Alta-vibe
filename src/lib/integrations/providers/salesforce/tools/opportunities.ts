import type { ProviderRuntimeToolSpec } from "../../types";
import {
  SALESFORCE_API_VERSION,
  SALESFORCE_FIELDS_OBJECT,
  SALESFORCE_GET_BY_ID_QUERY_SCHEMA,
  SALESFORCE_SOQL_QUERY_SCHEMA,
  SALESFORCE_UPDATE_BODY_SCHEMA,
} from "../schemas";

const V = SALESFORCE_API_VERSION;

/**
 * Salesforce Opportunity tools — in-call CRUD over the sObject + query
 * resources. Opportunities are the deal/pipeline records; Name, StageName,
 * and CloseDate are required on create, and AccountId links the deal to its
 * company.
 */
export const SALESFORCE_OPPORTUNITY_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Opportunities ─────────────────────────────────────────────────────
  {
    key: "create_opportunity",
    name: "salesforce_create_opportunity",
    description:
      "Create a Salesforce Opportunity (deal). Pass Salesforce API field names (Name, StageName, CloseDate, Amount, AccountId, …) in the fields map. " +
      "Name, StageName, and CloseDate (YYYY-MM-DD) are required by Salesforce. Returns { id, success, errors }.",
    phase: "in_call",
    method: "POST",
    path: `/services/data/${V}/sobjects/Opportunity`,
    category: "Opportunities",
    body_schema: SALESFORCE_FIELDS_OBJECT,
  },
  {
    key: "get_opportunity_by_id",
    name: "salesforce_get_opportunity_by_id",
    description:
      "Fetch a Salesforce Opportunity by its record id. Pass `fields` to narrow the returned columns; omit to return all fields.",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/sobjects/Opportunity/{id}`,
    path_template: true,
    category: "Opportunities",
    query_schema: SALESFORCE_GET_BY_ID_QUERY_SCHEMA,
  },
  {
    key: "update_opportunity",
    name: "salesforce_update_opportunity",
    description:
      "Update fields on an existing Salesforce Opportunity by id (e.g. advance StageName, set Amount). Only pass the fields you want to change. " +
      "Returns 204 No Content on success.",
    phase: "in_call",
    method: "PATCH",
    path: `/services/data/${V}/sobjects/Opportunity/{id}`,
    path_template: true,
    category: "Opportunities",
    body_schema: SALESFORCE_UPDATE_BODY_SCHEMA,
  },
  {
    key: "search_opportunities",
    name: "salesforce_search_opportunities",
    description:
      "Search Salesforce Opportunities with a SOQL query. " +
      "Example q: \"SELECT Id, Name, StageName, Amount, CloseDate FROM Opportunity WHERE AccountId = '001...' LIMIT 5\".",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/query/`,
    category: "Opportunities",
    query_schema: SALESFORCE_SOQL_QUERY_SCHEMA,
  },
];
