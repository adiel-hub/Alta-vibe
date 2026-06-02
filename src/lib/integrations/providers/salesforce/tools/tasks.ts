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
 * Salesforce Task tools. A Task is Salesforce's activity record — the natural
 * home for "log a call" once the conversation ends. The post_call tool creates
 * a completed call Task; the WhoId / WhatId fields link it to the caller's
 * Contact/Lead (WhoId) and a related Account/Opportunity/Case (WhatId), which
 * the agent can fill from the pre-call caller_salesforce_contact_id /
 * caller_salesforce_lead_id variables. In-call CRUD + search round out the set
 * for creating follow-up to-dos mid-call.
 *
 * Common Task fields:
 *   Subject (string), Description (long text), Status (Not Started | In
 *   Progress | Completed | Waiting on someone else | Deferred), Priority (High
 *   | Normal | Low), ActivityDate (YYYY-MM-DD due date), TaskSubtype ('Call'
 *   to render as a logged call), CallDurationInSeconds (number), WhoId
 *   (Contact/Lead id), WhatId (Account/Opportunity/Case id).
 */
export const SALESFORCE_TASK_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Tasks / activity logging ──────────────────────────────────────────
  {
    key: "log_call",
    name: "salesforce_log_call",
    description:
      "Log the completed call as a Salesforce Task on the caller's timeline. " +
      "Set Subject (e.g. 'Call - follow-up'), Description (call summary), Status: 'Completed', TaskSubtype: 'Call', " +
      "optional CallDurationInSeconds, and link it via WhoId (Contact/Lead id, e.g. {{caller_salesforce_contact_id}}) " +
      "and/or WhatId (Account/Opportunity/Case id). Returns { id, success, errors }.",
    phase: "post_call",
    method: "POST",
    path: `/services/data/${V}/sobjects/Task`,
    category: "Tasks",
    body_schema: SALESFORCE_FIELDS_OBJECT,
  },
  {
    key: "create_task",
    name: "salesforce_create_task",
    description:
      "Create a Salesforce Task (follow-up to-do). Pass Salesforce API field names (Subject, Description, Status, Priority, ActivityDate, WhoId, WhatId, OwnerId, …) in the fields map. " +
      "Returns { id, success, errors }.",
    phase: "in_call",
    method: "POST",
    path: `/services/data/${V}/sobjects/Task`,
    category: "Tasks",
    body_schema: SALESFORCE_FIELDS_OBJECT,
  },
  {
    key: "get_task_by_id",
    name: "salesforce_get_task_by_id",
    description:
      "Fetch a Salesforce Task by its record id. Pass `fields` to narrow the returned columns; omit to return all fields.",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/sobjects/Task/{id}`,
    path_template: true,
    category: "Tasks",
    query_schema: SALESFORCE_GET_BY_ID_QUERY_SCHEMA,
  },
  {
    key: "update_task",
    name: "salesforce_update_task",
    description:
      "Update fields on an existing Salesforce Task by id (e.g. set Status to 'Completed'). Only pass the fields you want to change. " +
      "Returns 204 No Content on success.",
    phase: "in_call",
    method: "PATCH",
    path: `/services/data/${V}/sobjects/Task/{id}`,
    path_template: true,
    category: "Tasks",
    body_schema: SALESFORCE_UPDATE_BODY_SCHEMA,
  },
  {
    key: "search_tasks",
    name: "salesforce_search_tasks",
    description:
      "Search Salesforce Tasks with a SOQL query. " +
      "Example q: \"SELECT Id, Subject, Status, ActivityDate FROM Task WHERE WhoId = '003...' ORDER BY ActivityDate DESC LIMIT 5\".",
    phase: "in_call",
    method: "GET",
    path: `/services/data/${V}/query/`,
    category: "Tasks",
    query_schema: SALESFORCE_SOQL_QUERY_SCHEMA,
  },
];
