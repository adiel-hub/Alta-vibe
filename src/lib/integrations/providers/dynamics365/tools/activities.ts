import type { ProviderRuntimeToolSpec } from "../../types";
import { DYNAMICS_RECORD_OBJECT, DYNAMICS_QUERY_SCHEMA } from "../schemas";

/**
 * Dynamics 365 (Dataverse) activity tools — tasks and phonecalls.
 *
 * Task entity set: `tasks` (EntityType `task`, primary key `activityid`).
 *   Columns: subject, description, scheduledstart, scheduledend, prioritycode,
 *   regardingobjectid (polymorphic owner of the activity).
 *
 * Phonecall entity set: `phonecalls` (EntityType `phonecall`, primary key
 *   `activityid`). Columns: subject, description, phonenumber, directioncode
 *   (false = incoming, true = outgoing), actualdurationminutes,
 *   regardingobjectid.
 *
 * Activities attach to a parent record via the polymorphic `regardingobjectid`
 * lookup. Disambiguate the target table with the typed navigation property,
 * e.g. 'regardingobjectid_contact@odata.bind': '/contacts(<contactid>)' or
 * 'regardingobjectid_account@odata.bind': '/accounts(<accountid>)'.
 */
export const DYNAMICS365_ACTIVITY_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Tasks (in-call CRUD) ────────────────────────────────────────────────
  {
    key: "create_task",
    name: "dynamics365_create_task",
    description:
      "Create a Dynamics 365 task. Pass Dataverse column logical names (subject, " +
      "description, scheduledend, prioritycode, …) as a flat JSON object. Attach it to " +
      "a record with 'regardingobjectid_contact@odata.bind': '/contacts(<contactid>)' " +
      "(or _account / _opportunity / _lead).",
    phase: "in_call",
    method: "POST",
    path: "/api/data/v9.2/tasks",
    category: "Activities",
    body_schema: DYNAMICS_RECORD_OBJECT,
  },
  {
    key: "search_tasks",
    name: "dynamics365_search_tasks",
    description:
      "Search Dynamics 365 tasks with an OData $filter/$select query. Returns the " +
      "matching rows in a `value` array.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/tasks",
    category: "Activities",
    query_schema: DYNAMICS_QUERY_SCHEMA,
  },
  {
    key: "update_task",
    name: "dynamics365_update_task",
    description:
      "Update columns on an existing Dynamics 365 task by its activityid. Only pass the " +
      "columns you want to change.",
    phase: "in_call",
    method: "PATCH",
    path: "/api/data/v9.2/tasks({taskId})",
    path_template: true,
    category: "Activities",
    body_schema: {
      type: "object",
      description:
        "Pass `taskId` (the task's activityid GUID) plus the column logical names to " +
        "change as sibling keys. `taskId` is consumed by the URL and not written.",
      properties: {
        taskId: {
          type: "string",
          description: "Task GUID (activityid), substituted into the URL.",
        },
      },
      required: ["taskId"],
      additionalProperties: true,
    },
  },

  // ── Post-call summary (phonecall activity) ──────────────────────────────
  {
    key: "log_phonecall",
    name: "dynamics365_log_phonecall",
    description:
      "Log a completed phone call as a Dynamics 365 phonecall activity summarizing the " +
      "conversation. Pass column logical names: subject (short headline), description " +
      "(the call summary), phonenumber, directioncode (false=incoming, true=outgoing), " +
      "actualdurationminutes. Attach to the contact with " +
      "'regardingobjectid_contact@odata.bind': '/contacts({{field:caller_dynamics_contact_id}})' " +
      "when the contact id is known.",
    phase: "post_call",
    method: "POST",
    path: "/api/data/v9.2/phonecalls",
    category: "Activities",
    body_schema: DYNAMICS_RECORD_OBJECT,
  },
];
