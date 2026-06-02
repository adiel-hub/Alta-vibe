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
 * Salesforce Case tools — in-call CRUD over the sObject + query resources.
 * Cases are the service/support records; link them to the caller via ContactId
 * and AccountId. Subject/Status/Origin/Priority are the common fields.
 */
export const SALESFORCE_CASE_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Cases ─────────────────────────────────────────────────────────────
  {
    key: "create_case",
    name: "salesforce_create_case",
    description:
      "Create a Salesforce Case (support/service ticket). Pass Salesforce API field names (Subject, Description, Status, Priority, Origin, ContactId, AccountId, …) in the fields map. " +
      "Returns { id, success, errors }.",
    phase: "in_call",
    method: "POST",
    path: `/services/data/${V}/sobjects/Case`,
    category: "Cases",
    body_schema: SALESFORCE_FIELDS_OBJECT,
  },
  {
    key: "get_case_by_id",
    name: "salesforce_get_case_by_id",
    description:
      "Fetch a Salesforce Case by its record id. Pass `fields` to narrow the returned columns; omit to return all fields.",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/sobjects/Case/{id}`,
    path_template: true,
    category: "Cases",
    query_schema: SALESFORCE_GET_BY_ID_QUERY_SCHEMA,
  },
  {
    key: "update_case",
    name: "salesforce_update_case",
    description:
      "Update fields on an existing Salesforce Case by id (e.g. set Status to 'Closed', change Priority). Only pass the fields you want to change. " +
      "Returns 204 No Content on success.",
    phase: "in_call",
    method: "PATCH",
    path: `/services/data/${V}/sobjects/Case/{id}`,
    path_template: true,
    category: "Cases",
    body_schema: SALESFORCE_UPDATE_BODY_SCHEMA,
  },
  {
    key: "search_cases",
    name: "salesforce_search_cases",
    description:
      "Search Salesforce Cases with a SOQL query. " +
      "Example q: \"SELECT Id, CaseNumber, Subject, Status, Priority FROM Case WHERE ContactId = '003...' LIMIT 5\".",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/query/`,
    category: "Cases",
    query_schema: SALESFORCE_SOQL_QUERY_SCHEMA,
  },
];
