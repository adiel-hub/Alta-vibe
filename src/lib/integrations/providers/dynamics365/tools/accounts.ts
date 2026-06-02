import type { ProviderRuntimeToolSpec } from "../../types";
import { DYNAMICS_RECORD_OBJECT, DYNAMICS_QUERY_SCHEMA } from "../schemas";

/**
 * Dynamics 365 (Dataverse) account tools.
 *
 * Entity set: `accounts` (EntityType `account`, primary key `accountid`).
 * Useful columns: name, telephone1, emailaddress1, websiteurl, industrycode,
 * revenue, numberofemployees, primarycontactid (contact lookup).
 */
export const DYNAMICS365_ACCOUNT_TOOLS: ProviderRuntimeToolSpec[] = [
  {
    key: "create_account",
    name: "dynamics365_create_account",
    description:
      "Create a new Dynamics 365 account (company). Pass Dataverse column logical " +
      "names (name, telephone1, websiteurl, revenue, numberofemployees, …) as a flat " +
      "JSON object. Link a primary contact with " +
      "'primarycontactid@odata.bind': '/contacts(<contactid>)'.",
    phase: "in_call",
    method: "POST",
    path: "/api/data/v9.2/accounts",
    category: "Accounts",
    body_schema: DYNAMICS_RECORD_OBJECT,
  },
  {
    key: "search_accounts",
    name: "dynamics365_search_accounts",
    description:
      "Search Dynamics 365 accounts with an OData $filter/$select query. Returns the " +
      "matching rows in a `value` array.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/accounts",
    category: "Accounts",
    query_schema: DYNAMICS_QUERY_SCHEMA,
  },
  {
    key: "get_account_by_id",
    name: "dynamics365_get_account_by_id",
    description:
      "Fetch a Dynamics 365 account by its accountid (GUID). Use $select to limit the " +
      "columns returned.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/accounts({accountId})",
    path_template: true,
    category: "Accounts",
    query_schema: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "Account GUID (accountid), substituted into the URL.",
        },
        $select: {
          type: "string",
          description: "Comma-separated column logical names to return.",
        },
      },
      required: ["accountId"],
    },
  },
  {
    key: "update_account",
    name: "dynamics365_update_account",
    description:
      "Update columns on an existing Dynamics 365 account by accountid. Only pass the " +
      "columns you want to change.",
    phase: "in_call",
    method: "PATCH",
    path: "/api/data/v9.2/accounts({accountId})",
    path_template: true,
    category: "Accounts",
    body_schema: {
      type: "object",
      description:
        "Pass `accountId` (the GUID to update) plus the column logical names to change " +
        "as sibling keys. `accountId` is consumed by the URL and not written.",
      properties: {
        accountId: {
          type: "string",
          description: "Account GUID (accountid), substituted into the URL.",
        },
      },
      required: ["accountId"],
      additionalProperties: true,
    },
  },
];
