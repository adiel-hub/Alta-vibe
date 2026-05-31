import type { IntegrationProvider } from "../types";

export const SLACK_PROVIDER: IntegrationProvider = {
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
      category: "Messaging",
    },
    {
      key: "alert_on_escalation",
      name: "slack_alert_on_escalation",
      description: "Send an alert to the on-call Slack channel during the call.",
      phase: "in_call",
      method: "POST",
      path: "/chat.postMessage",
      category: "Messaging",
    },
  ],
};
