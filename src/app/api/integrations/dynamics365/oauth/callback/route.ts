import { createOAuthCallbackRoute } from "@/lib/integrations/oauth/routeFactory";
import { DYNAMICS365_OAUTH_CONFIG } from "@/lib/integrations/dynamics365/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET } = createOAuthCallbackRoute(DYNAMICS365_OAUTH_CONFIG, {
  buildEffectMessage: ({ addedTools, email }) => {
    const emailLine = email ? ` Connected as ${email}.` : "";
    return (
      `User connected Microsoft Dynamics 365.${emailLine} ${addedTools} runtime tool${addedTools === 1 ? "" : "s"} ` +
      `are now available on the agent (lookup_contact pre-call enrichment, plus create/search/get/update for ` +
      `contacts, accounts, leads, opportunities and tasks, and a post-call phonecall log). ` +
      `Ask the user — in one short message — whether they want to wire any of these into the workflow now ` +
      `(e.g., enrich the caller from Dynamics before the call, create a lead or task mid-conversation, or log a phonecall summary at the end). ` +
      `If they say yes, propose a concrete spot in the current workflow and use edit_workflow to add the node(s); if they say no or "later", acknowledge briefly and move on. ` +
      `Do NOT modify the workflow before they answer.`
    );
  },
});
