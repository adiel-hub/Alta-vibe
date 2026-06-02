import { createOAuthCallbackRoute } from "@/lib/integrations/oauth/routeFactory";
import { OUTLOOK_CALENDAR_OAUTH_CONFIG } from "@/lib/integrations/outlook_calendar/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET } = createOAuthCallbackRoute(OUTLOOK_CALENDAR_OAUTH_CONFIG, {
  buildEffectMessage: ({ addedTools, email }) => {
    const emailLine = email ? ` Connected as ${email}.` : "";
    return (
      `User connected Microsoft Outlook Calendar.${emailLine} ${addedTools} runtime tool${addedTools === 1 ? "" : "s"} ` +
      `(check_availability, book_meeting) are now available on the agent. ` +
      `Ask the user — in one short message — whether they want to wire calendar checks into the workflow now ` +
      `(e.g., add a tool_call node that checks availability before quoting a time, or books the meeting — optionally as a Microsoft Teams meeting — at the end of the call). ` +
      `If they say yes, propose a concrete spot in the current workflow and use edit_workflow to add the node(s); if they say no or "later", acknowledge briefly and move on. ` +
      `Do NOT modify the workflow before they answer.`
    );
  },
});
