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
 * Salesforce Account tools — in-call CRUD over the sObject + query resources.
 * Accounts are the company records Contacts and Opportunities hang off of.
 */
export const SALESFORCE_ACCOUNT_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Accounts ──────────────────────────────────────────────────────────
  {
    key: "create_account",
    name: "salesforce_create_account",
    description:
      "Create a Salesforce Account (company). Pass Salesforce API field names (Name, Phone, Website, Industry, Type, …) in the fields map. " +
      "Name is required by Salesforce. Returns { id, success, errors }.",
    phase: "in_call",
    method: "POST",
    path: `/services/data/${V}/sobjects/Account`,
    category: "Accounts",
    body_schema: SALESFORCE_FIELDS_OBJECT,
  },
  {
    key: "get_account_by_id",
    name: "salesforce_get_account_by_id",
    description:
      "Fetch a Salesforce Account by its record id. Pass `fields` to narrow the returned columns; omit to return all fields.",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/sobjects/Account/{id}`,
    path_template: true,
    category: "Accounts",
    query_schema: SALESFORCE_GET_BY_ID_QUERY_SCHEMA,
  },
  {
    key: "update_account",
    name: "salesforce_update_account",
    description:
      "Update fields on an existing Salesforce Account by id. Only pass the fields you want to change. Returns 204 No Content on success.",
    phase: "in_call",
    method: "PATCH",
    path: `/services/data/${V}/sobjects/Account/{id}`,
    path_template: true,
    category: "Accounts",
    body_schema: SALESFORCE_UPDATE_BODY_SCHEMA,
  },
  {
    key: "search_accounts",
    name: "salesforce_search_accounts",
    description:
      "Search Salesforce Accounts with a SOQL query. " +
      "Example q: \"SELECT Id, Name, Industry, Phone FROM Account WHERE Name LIKE 'Acme%' LIMIT 5\".",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/query/`,
    category: "Accounts",
    query_schema: SALESFORCE_SOQL_QUERY_SCHEMA,
  },
];
