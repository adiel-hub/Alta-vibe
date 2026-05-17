/**
 * Integration provider registry. Each provider declares:
 *   - identity (id, name, description)
 *   - a list of runtime tool specs registered on the agent the moment the
 *     user connects this provider (e.g. HubSpot → look_up_contact,
 *     create_deal, etc.)
 *   - OAuth metadata (for future real OAuth; prototype stubs return mocked
 *     credentials immediately).
 *
 * Adding a new provider = one entry in PROVIDERS. The widget, connect
 * endpoint, and tool registration all derive from this table.
 */
import type { RuntimePhase } from "@/types/agent";

export type ProviderRuntimeToolSpec = {
  name: string;
  description: string;
  phase: RuntimePhase;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Relative path; full URL = provider.base_api_url + path. */
  path: string;
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

export const PROVIDERS: IntegrationProvider[] = [
  {
    id: "hubspot",
    name: "HubSpot",
    description: "CRM contacts, deals, tickets.",
    icon: "🟠",
    base_api_url: "https://api.hubapi.com",
    oauth: {
      authorize_url: "https://app.hubspot.com/oauth/authorize",
      token_url: "https://api.hubapi.com/oauth/v1/token",
      scopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"],
    },
    runtime_tools: [
      {
        name: "hubspot_lookup_contact",
        description:
          "Look up a HubSpot contact by phone number or email and return profile + recent activity.",
        phase: "pre_call",
        method: "POST",
        path: "/crm/v3/objects/contacts/search",
      },
      {
        name: "hubspot_create_ticket",
        description: "Create a HubSpot support ticket from the current call.",
        phase: "in_call",
        method: "POST",
        path: "/crm/v3/objects/tickets",
      },
      {
        name: "hubspot_log_call",
        description: "Log a call activity on the contact's timeline after hangup.",
        phase: "post_call",
        method: "POST",
        path: "/crm/v3/objects/calls",
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Post notifications and summaries to channels.",
    icon: "🔷",
    base_api_url: "https://slack.com/api",
    oauth: {
      authorize_url: "https://slack.com/oauth/v2/authorize",
      token_url: "https://slack.com/api/oauth.v2.access",
      scopes: ["chat:write", "channels:read"],
    },
    runtime_tools: [
      {
        name: "slack_post_call_summary",
        description: "Post the call summary + outcome to a Slack channel.",
        phase: "post_call",
        method: "POST",
        path: "/chat.postMessage",
      },
      {
        name: "slack_alert_on_escalation",
        description: "Send an alert to the on-call Slack channel during the call.",
        phase: "in_call",
        method: "POST",
        path: "/chat.postMessage",
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Read/write pages and databases.",
    icon: "⬛",
    base_api_url: "https://api.notion.com/v1",
    oauth: {
      authorize_url: "https://api.notion.com/v1/oauth/authorize",
      token_url: "https://api.notion.com/v1/oauth/token",
      scopes: [],
    },
    runtime_tools: [
      {
        name: "notion_lookup_doc",
        description: "Search Notion for relevant docs mid-conversation.",
        phase: "in_call",
        method: "POST",
        path: "/search",
      },
    ],
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Send follow-up emails after a call.",
    icon: "📧",
    base_api_url: "https://gmail.googleapis.com",
    oauth: {
      authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
      token_url: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/gmail.send"],
    },
    runtime_tools: [
      {
        name: "gmail_send_followup",
        description: "Send a follow-up email after a call.",
        phase: "post_call",
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
      },
    ],
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Look up customers, subscriptions, payments.",
    icon: "🟣",
    base_api_url: "https://api.stripe.com",
    oauth: {
      authorize_url: "https://connect.stripe.com/oauth/authorize",
      token_url: "https://connect.stripe.com/oauth/token",
      scopes: ["read_only"],
    },
    runtime_tools: [
      {
        name: "stripe_lookup_customer",
        description:
          "Look up a Stripe customer by email or id and return their active subscriptions.",
        phase: "pre_call",
        method: "GET",
        path: "/v1/customers",
      },
    ],
  },
];

export function getProvider(id: string): IntegrationProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
