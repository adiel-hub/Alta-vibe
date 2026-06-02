import { createOAuthCallbackRoute } from "@/lib/integrations/oauth/routeFactory";
import { SALESFORCE_OAUTH_CONFIG } from "@/lib/integrations/salesforce/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET } = createOAuthCallbackRoute(SALESFORCE_OAUTH_CONFIG, {
  buildEffectMessage: ({ addedTools, email }) => {
    const emailLine = email ? ` Connected as ${email}.` : "";
    return (
      `User connected Salesforce.${emailLine} ${addedTools} runtime tool${addedTools === 1 ? "" : "s"} ` +
      `are now available on the agent — a pre-call Contact/Lead lookup (enriches caller_first_name, caller_company, ` +
      `caller_salesforce_contact_id, …), in-call CRUD for Contacts, Leads, Accounts, Opportunities, Cases and Tasks, ` +
      `and a post-call "log call as a Task" action. ` +
      `Ask the user — in one short message — whether they want to wire any of these into the workflow now ` +
      `(e.g., look the caller up before dialing, create/update a record mid-call, or log the call as a Task at the end). ` +
      `If they say yes, propose a concrete spot in the current workflow and use edit_workflow to add the node(s); ` +
      `if they say no or "later", acknowledge briefly and move on. ` +
      `Do NOT modify the workflow before they answer.`
    );
  },
});
