/**
 * Integration provider registry. Each provider declares:
 *   - identity (id, name, description)
 *   - a catalog of runtime tool specs the agent can install (e.g. HubSpot →
 *     create_contact, find_contact_by_email, log_call, …). Tools marked
 *     `default_install` are wired up automatically the moment the provider
 *     connects; the rest are opt-in via the Tools tab or the
 *     `install_provider_tool` capability.
 *   - OAuth metadata (placeholder; v1 uses paste-a-PAT).
 *
 * Schemas: each tool carries its own JSON-schema for body and/or query so
 * ElevenLabs can describe to the LLM exactly what shape to produce. The
 * proxy forwards whatever ElevenLabs sends, so the schema is the contract.
 *
 * Path templates: HubSpot routes like /crm/v3/objects/contacts/{contactId}
 * expect the id in the URL. Tools with `path_template: true` get those
 * `{var}` placeholders substituted from request body keys at proxy time —
 * the substituted keys are stripped from the forwarded body so HubSpot
 * doesn't see them as unknown properties.
 */
import type { RuntimePhase } from "@/types/agent";

export type ProviderRuntimeToolSpec = {
  /** Stable handle, distinct from the phase-scoped tool name used on ElevenLabs. */
  key: string;
  /** Tool name as it appears on ElevenLabs (pre/post-call get phase-prefixed at install time). */
  name: string;
  description: string;
  phase: RuntimePhase;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Relative path; full URL = provider.base_api_url + path (after template substitution). */
  path: string;
  /** When true, the proxy substitutes `{var}` placeholders in `path` from the request body. */
  path_template?: boolean;
  /** Optional JSON-Schema for the request body (forwarded to ElevenLabs as request_body_schema). */
  body_schema?: Record<string, unknown>;
  /** Optional JSON-Schema for query params (forwarded as query_params_schema). */
  query_schema?: Record<string, unknown>;
  /** Auto-install when the provider connects. Defaults to false. */
  default_install?: boolean;
  /** UI grouping label (e.g. "Contacts", "Deals"). */
  category?: string;
};

export type IntegrationProvider = {
  id: string;
  name: string;
  description: string;
  icon: string;
  base_api_url: string;
  oauth: {
    authorize_url: string;
    token_url: string;
    scopes: string[];
  };
  runtime_tools: ProviderRuntimeToolSpec[];
};

// ── HubSpot ────────────────────────────────────────────────────────────────
// Body schemas reference the HubSpot v3 CRM API. `properties` is a flat
// string-map on the wire; we declare it as an object with HubSpot's most
// useful property keys but keep `additionalProperties` so the LLM can pass
// custom property names too.

const HUBSPOT_PROPERTIES_OBJECT = {
  type: "object",
  description:
    "Flat string-map of HubSpot property names → values. HubSpot stores all property values as strings on the wire.",
  additionalProperties: { type: "string" },
} as const;

const HUBSPOT_SEARCH_BODY_SCHEMA = {
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
      items: { type: "string" },
    },
    limit: { type: "integer", description: "Max records to return (default 10, max 100)." },
    after: { type: "string", description: "Pagination cursor from a previous response." },
    sorts: {
      type: "array",
      description: "Optional list of property-name/direction pairs.",
      items: { type: "string" },
    },
  },
} as const;

const HUBSPOT_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Contacts ──────────────────────────────────────────────────────────
  {
    key: "create_contact",
    name: "hubspot_create_contact",
    description: "Create a new HubSpot contact. Pass HubSpot property names (firstname, lastname, email, phone, company, lifecyclestage, etc.) in the properties map.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/contacts",
    category: "Contacts",
    body_schema: {
      type: "object",
      properties: {
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["properties"],
    },
  },
  {
    key: "lookup_contact",
    name: "hubspot_lookup_contact",
    description: "Look up a HubSpot contact by phone or email and return profile + recent activity. Pass either email or phone in the filterGroups.",
    phase: "pre_call",
    method: "POST",
    path: "/crm/v3/objects/contacts/search",
    default_install: true,
    category: "Contacts",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
  {
    key: "search_contacts",
    name: "hubspot_search_contacts",
    description: "Generic HubSpot contact search by any property/operator combination. Use for mid-conversation lookups beyond the pre-call enrichment.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/contacts/search",
    category: "Contacts",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
  {
    key: "get_contact_by_id",
    name: "hubspot_get_contact_by_id",
    description: "Fetch a HubSpot contact by its record id. Returns all default properties plus any requested ones.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/objects/contacts/{contactId}",
    path_template: true,
    category: "Contacts",
    query_schema: {
      properties: {
        contactId: { type: "string", description: "HubSpot contact record id (substituted into the URL)." },
        properties: { type: "string", description: "Comma-separated list of property names to return." },
      },
      required: ["contactId"],
    },
  },
  {
    key: "update_contact",
    name: "hubspot_update_contact",
    description: "Update properties on an existing HubSpot contact by id. Only pass properties you want to change.",
    phase: "in_call",
    method: "PATCH",
    path: "/crm/v3/objects/contacts/{contactId}",
    path_template: true,
    category: "Contacts",
    body_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "HubSpot contact record id (substituted into the URL)." },
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["contactId", "properties"],
    },
  },
  {
    key: "archive_contact",
    name: "hubspot_archive_contact",
    description: "Archive (soft-delete) a HubSpot contact by id. Reversible from the HubSpot UI for 90 days.",
    phase: "post_call",
    method: "DELETE",
    path: "/crm/v3/objects/contacts/{contactId}",
    path_template: true,
    category: "Contacts",
    query_schema: {
      properties: {
        contactId: { type: "string", description: "HubSpot contact record id (substituted into the URL)." },
      },
      required: ["contactId"],
    },
  },

  // ── Companies ─────────────────────────────────────────────────────────
  {
    key: "create_company",
    name: "hubspot_create_company",
    description: "Create a new HubSpot company. Pass HubSpot property names (name, domain, industry, phone, city, etc.) in the properties map.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/companies",
    category: "Companies",
    body_schema: {
      type: "object",
      properties: { properties: HUBSPOT_PROPERTIES_OBJECT },
      required: ["properties"],
    },
  },
  {
    key: "search_companies",
    name: "hubspot_search_companies",
    description: "Search HubSpot companies by any property/operator combination (e.g. domain EQ acme.com, industry IN […]).",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/companies/search",
    category: "Companies",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
  {
    key: "get_company_by_id",
    name: "hubspot_get_company_by_id",
    description: "Fetch a HubSpot company by its record id.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/objects/companies/{companyId}",
    path_template: true,
    category: "Companies",
    query_schema: {
      properties: {
        companyId: { type: "string", description: "HubSpot company record id (substituted into the URL)." },
        properties: { type: "string", description: "Comma-separated list of property names to return." },
      },
      required: ["companyId"],
    },
  },
  {
    key: "update_company",
    name: "hubspot_update_company",
    description: "Update properties on an existing HubSpot company by id.",
    phase: "in_call",
    method: "PATCH",
    path: "/crm/v3/objects/companies/{companyId}",
    path_template: true,
    category: "Companies",
    body_schema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "HubSpot company record id (substituted into the URL)." },
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["companyId", "properties"],
    },
  },

  // ── Deals ─────────────────────────────────────────────────────────────
  {
    key: "create_deal",
    name: "hubspot_create_deal",
    description: "Create a HubSpot deal. Required properties typically include dealname, pipeline, dealstage; commonly also amount, closedate, hubspot_owner_id.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/deals",
    category: "Deals",
    body_schema: {
      type: "object",
      properties: { properties: HUBSPOT_PROPERTIES_OBJECT },
      required: ["properties"],
    },
  },
  {
    key: "get_deal_by_id",
    name: "hubspot_get_deal_by_id",
    description: "Fetch a HubSpot deal by its record id.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/objects/deals/{dealId}",
    path_template: true,
    category: "Deals",
    query_schema: {
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id (substituted into the URL)." },
        properties: { type: "string", description: "Comma-separated list of property names to return." },
      },
      required: ["dealId"],
    },
  },
  {
    key: "update_deal",
    name: "hubspot_update_deal",
    description: "Update properties on an existing HubSpot deal by id (amount, dealname, closedate, custom fields, etc.).",
    phase: "in_call",
    method: "PATCH",
    path: "/crm/v3/objects/deals/{dealId}",
    path_template: true,
    category: "Deals",
    body_schema: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id (substituted into the URL)." },
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["dealId", "properties"],
    },
  },
  {
    key: "move_deal_stage",
    name: "hubspot_move_deal_stage",
    description: "Move a HubSpot deal to a different pipeline stage. Pass the deal id and the target dealstage id (use list_deal_pipelines to discover stage ids).",
    phase: "post_call",
    method: "PATCH",
    path: "/crm/v3/objects/deals/{dealId}",
    path_template: true,
    category: "Deals",
    body_schema: {
      type: "object",
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id (substituted into the URL)." },
        properties: {
          type: "object",
          properties: {
            dealstage: { type: "string", description: "Target dealstage id." },
          },
          required: ["dealstage"],
        },
      },
      required: ["dealId", "properties"],
    },
  },
  {
    key: "search_deals",
    name: "hubspot_search_deals",
    description: "Search HubSpot deals by any property (e.g. associated contact id, dealstage, amount range, hubspot_owner_id).",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/deals/search",
    category: "Deals",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },
  {
    key: "list_deal_pipelines",
    name: "hubspot_list_deal_pipelines",
    description: "List all HubSpot deal pipelines and their stages. Useful before creating deals or moving them between stages.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/pipelines/deals",
    category: "Deals",
  },

  // ── Tickets ───────────────────────────────────────────────────────────
  {
    key: "create_ticket",
    name: "hubspot_create_ticket",
    description: "Create a HubSpot support ticket from the current call. Required properties: subject, hs_pipeline, hs_pipeline_stage. Commonly include hs_ticket_priority and content.",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/tickets",
    default_install: true,
    category: "Tickets",
    body_schema: {
      type: "object",
      properties: { properties: HUBSPOT_PROPERTIES_OBJECT },
      required: ["properties"],
    },
  },
  {
    key: "update_ticket",
    name: "hubspot_update_ticket",
    description: "Update properties on an existing HubSpot ticket by id (status, priority, owner, custom fields).",
    phase: "in_call",
    method: "PATCH",
    path: "/crm/v3/objects/tickets/{ticketId}",
    path_template: true,
    category: "Tickets",
    body_schema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: "HubSpot ticket record id (substituted into the URL)." },
        properties: HUBSPOT_PROPERTIES_OBJECT,
      },
      required: ["ticketId", "properties"],
    },
  },
  {
    key: "search_tickets",
    name: "hubspot_search_tickets",
    description: "Search HubSpot tickets by any property (e.g. associated contact id, hs_pipeline_stage, hs_ticket_priority).",
    phase: "in_call",
    method: "POST",
    path: "/crm/v3/objects/tickets/search",
    category: "Tickets",
    body_schema: HUBSPOT_SEARCH_BODY_SCHEMA,
  },

  // ── Engagements / activity logging ────────────────────────────────────
  {
    key: "log_call",
    name: "hubspot_log_call",
    description: "Log a call activity on the contact's timeline after hangup. Required properties: hs_timestamp (unix-ms), hs_call_title, hs_call_body; optional hs_call_duration, hs_call_status, hubspot_owner_id.",
    phase: "post_call",
    method: "POST",
    path: "/crm/v3/objects/calls",
    default_install: true,
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

  // ── Owners / metadata ─────────────────────────────────────────────────
  {
    key: "list_owners",
    name: "hubspot_list_owners",
    description: "List HubSpot users (owners) available for assignment. Returns id, email, firstName, lastName for each.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/owners",
    category: "Metadata",
    query_schema: {
      properties: {
        email: { type: "string", description: "Filter by exact owner email." },
        limit: { type: "integer", description: "Max records (default 100)." },
      },
    },
  },

  // ── Associations ──────────────────────────────────────────────────────
  {
    key: "associate_contact_to_company",
    name: "hubspot_associate_contact_to_company",
    description: "Associate a HubSpot contact with a company using the default association type.",
    phase: "in_call",
    method: "PUT",
    path: "/crm/v4/objects/contacts/{contactId}/associations/default/companies/{companyId}",
    path_template: true,
    category: "Associations",
    query_schema: {
      properties: {
        contactId: { type: "string", description: "HubSpot contact record id." },
        companyId: { type: "string", description: "HubSpot company record id." },
      },
      required: ["contactId", "companyId"],
    },
  },
  {
    key: "associate_deal_to_contact",
    name: "hubspot_associate_deal_to_contact",
    description: "Associate a HubSpot deal with a contact using the default association type.",
    phase: "in_call",
    method: "PUT",
    path: "/crm/v4/objects/deals/{dealId}/associations/default/contacts/{contactId}",
    path_template: true,
    category: "Associations",
    query_schema: {
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id." },
        contactId: { type: "string", description: "HubSpot contact record id." },
      },
      required: ["dealId", "contactId"],
    },
  },
  {
    key: "associate_deal_to_company",
    name: "hubspot_associate_deal_to_company",
    description: "Associate a HubSpot deal with a company using the default association type.",
    phase: "in_call",
    method: "PUT",
    path: "/crm/v4/objects/deals/{dealId}/associations/default/companies/{companyId}",
    path_template: true,
    category: "Associations",
    query_schema: {
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id." },
        companyId: { type: "string", description: "HubSpot company record id." },
      },
      required: ["dealId", "companyId"],
    },
  },
];

export const PROVIDERS: IntegrationProvider[] = [
  {
    id: "hubspot",
    name: "HubSpot",
    description: "CRM contacts, companies, deals, tickets, engagements.",
    icon: "/integrations/hubspot.png",
    base_api_url: "https://api.hubapi.com",
    oauth: {
      authorize_url: "https://app.hubspot.com/oauth/authorize",
      token_url: "https://api.hubapi.com/oauth/v1/token",
      scopes: [
        "crm.objects.contacts.read",
        "crm.objects.contacts.write",
        "crm.objects.companies.read",
        "crm.objects.companies.write",
        "crm.objects.deals.read",
        "crm.objects.deals.write",
      ],
    },
    runtime_tools: HUBSPOT_TOOLS,
  },
  {
    id: "slack",
    name: "Slack",
    description: "Post notifications and summaries to channels.",
    icon: "/integrations/slack.png",
    base_api_url: "https://slack.com/api",
    oauth: {
      authorize_url: "https://slack.com/oauth/v2/authorize",
      token_url: "https://slack.com/api/oauth.v2.access",
      scopes: ["chat:write", "channels:read"],
    },
    runtime_tools: [
      {
        key: "post_call_summary",
        name: "slack_post_call_summary",
        description: "Post the call summary + outcome to a Slack channel.",
        phase: "post_call",
        method: "POST",
        path: "/chat.postMessage",
        default_install: true,
        category: "Messaging",
      },
      {
        key: "alert_on_escalation",
        name: "slack_alert_on_escalation",
        description: "Send an alert to the on-call Slack channel during the call.",
        phase: "in_call",
        method: "POST",
        path: "/chat.postMessage",
        default_install: true,
        category: "Messaging",
      },
    ],
  },
];

export function getProvider(id: string): IntegrationProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Look up a tool spec on a provider by either its stable `key` or its
 * (possibly phase-prefixed) wire name. The proxy uses this to find specs
 * by the toolName segment of its URL; capabilities use it to find by key.
 */
export function findProviderTool(
  providerId: string,
  keyOrName: string,
): ProviderRuntimeToolSpec | undefined {
  const provider = getProvider(providerId);
  if (!provider) return undefined;
  return provider.runtime_tools.find(
    (t) =>
      t.key === keyOrName ||
      t.name === keyOrName ||
      `${t.phase}__${t.name}` === keyOrName,
  );
}

/**
 * Phase-scope a wire name the way ElevenLabs expects: in-call tools use
 * the bare name; pre/post-call get prefixed so the runtime knows which
 * lifecycle hook fires them.
 */
export function scopedToolName(spec: ProviderRuntimeToolSpec): string {
  return spec.phase === "in_call" ? spec.name : `${spec.phase}__${spec.name}`;
}
