import type { ProviderRuntimeToolSpec } from "../../types";
import { HUBSPOT_PROPERTIES_OBJECT } from "../schemas";

export const HUBSPOT_ENGAGEMENT_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Engagements / activity logging ────────────────────────────────────
  {
    key: "log_call",
    name: "hubspot_log_call",
    description: "Log a call activity on the contact's timeline after hangup. Required properties: hs_timestamp (unix-ms), hs_call_title, hs_call_body; optional hs_call_duration, hs_call_status, hubspot_owner_id.",
    phase: "post_call",
    method: "POST",
    path: "/crm/v3/objects/calls",
    category: "Engagements",
    body_schema: {
      type: "object",
      properties: {
        properties: HUBSPOT_PROPERTIES_OBJECT,
        associations: {
          type: "array",
          description: "Optional associations to contacts/companies/deals. Each entry: { to: {id}, types: [{associationCategory, associationTypeId}] }.",
          items: { type: "object" },
        },
      },
      required: ["properties"],
    },
  },
  {
    key: "log_note",
    name: "hubspot_log_note",
    description: "Log a free-form note on a record's timeline. Required properties: hs_timestamp (unix-ms), hs_note_body. Pass associations to attach it to contacts/companies/deals.",
    phase: "post_call",
    method: "POST",
    path: "/crm/v3/objects/notes",
    category: "Engagements",
    body_schema: {
      type: "object",
      properties: {
        properties: HUBSPOT_PROPERTIES_OBJECT,
        associations: { type: "array", items: { type: "object" } },
      },
      required: ["properties"],
    },
  },
  {
    key: "log_email",
    name: "hubspot_log_email",
    description: "Log an email activity. Required properties: hs_timestamp (unix-ms), hs_email_subject, hs_email_text or hs_email_html.",
    phase: "post_call",
    method: "POST",
    path: "/crm/v3/objects/emails",
    category: "Engagements",
    body_schema: {
      type: "object",
      properties: {
        properties: HUBSPOT_PROPERTIES_OBJECT,
        associations: { type: "array", items: { type: "object" } },
      },
      required: ["properties"],
    },
  },
  {
    key: "log_meeting",
    name: "hubspot_log_meeting",
    description: "Log a meeting on the timeline. Required properties: hs_timestamp (unix-ms), hs_meeting_title; optional hs_meeting_start_time, hs_meeting_end_time, hs_meeting_body.",
    phase: "post_call",
    method: "POST",
    path: "/crm/v3/objects/meetings",
    category: "Engagements",
    body_schema: {
      type: "object",
      properties: {
        properties: HUBSPOT_PROPERTIES_OBJECT,
        associations: { type: "array", items: { type: "object" } },
      },
      required: ["properties"],
    },
  },
  {
    key: "create_task",
    name: "hubspot_create_task",
    description: "Create a HubSpot task (follow-up to-do). Required properties: hs_timestamp (due date, unix-ms), hs_task_subject; optional hs_task_body, hs_task_priority (LOW|MEDIUM|HIGH), hs_task_status (NOT_STARTED|IN_PROGRESS|COMPLETED|WAITING|DEFERRED), hubspot_owner_id.",
    phase: "post_call",
    method: "POST",
    path: "/crm/v3/objects/tasks",
    category: "Engagements",
    body_schema: {
      type: "object",
      properties: {
        properties: HUBSPOT_PROPERTIES_OBJECT,
        associations: { type: "array", items: { type: "object" } },
      },
      required: ["properties"],
    },
  },
];
