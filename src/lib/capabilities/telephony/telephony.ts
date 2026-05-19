import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  assignPhoneNumberToAgent,
  deletePhoneNumber,
  getConversationDetail,
  getPhoneNumber,
  getPhoneNumberSipMessages,
  initiateOutboundCall,
  listConversations,
  listPhoneNumbers,
  listPhoneNumbersForAgent,
  updatePhoneNumber,
} from "@/lib/elevenlabs/client";
import type { PhoneNumber } from "@/types/agent";
import type { Capability } from "../types";
import { runToolStep } from "../types";
import { createWidgetAction } from "../experience/widgets";

export const telephonyCapability: Capability = {
  id: "telephony",
  label: "Telephony",
  defaultSlice: () => ({ phone_numbers: [] }),
  tools: (ctx) => [
    tool(
      "list_phone_numbers",
      "List phone numbers available in the workspace.",
      {},
      async () => {
        const nums = await listPhoneNumbers();
        return { content: [{ type: "text", text: JSON.stringify(nums) }] };
      },
    ),

    tool(
      "assign_phone_number_to_agent",
      "Attach a workspace phone number to THIS agent so inbound calls reach it.",
      { phone_number_id: z.string().min(1) },
      async ({ phone_number_id }) =>
        runToolStep(ctx, "phone", "assign_phone", async () => {
          await assignPhoneNumberToAgent(phone_number_id, ctx.elevenlabs_agent_id);
          // Re-list from ElevenLabs and rebuild this agent's attached set
          // from `assigned_agent.agent_id`. We don't trust the local cache
          // here — the agent GET response doesn't reliably echo
          // phone_numbers, and previous assigns may have left stale rows.
          const attached: PhoneNumber[] = (
            await listPhoneNumbersForAgent(ctx.elevenlabs_agent_id)
          ).map((p) => ({
            id: p.id,
            number: p.number,
            provider: p.provider,
            label: p.label,
          }));
          const found = attached.find((p) => p.id === phone_number_id);
          return {
            patch: { phone_numbers: attached },
            summary: `Phone number attached${found ? ` (${found.number})` : ""}.`,
          };
        }),
    ),

    tool(
      "place_outbound_test_call",
      "Place an outbound test call from the agent to a number. Requires a phone number attached.",
      {
        to_number: z.string().regex(/^\+?[0-9 \-()]{6,20}$/, "invalid phone number"),
        agent_phone_number_id: z.string().min(1),
      },
      async ({ to_number, agent_phone_number_id }) => {
        try {
          const { conversation_id } = await initiateOutboundCall({
            agentId: ctx.elevenlabs_agent_id,
            agentPhoneNumberId: agent_phone_number_id,
            toNumber: to_number,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Outbound call initiated to ${to_number}. Conversation id: ${conversation_id}.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          ctx.emit({ type: "state_error", section: "phone", message });
          return {
            content: [
              {
                type: "text" as const,
                text: `outbound_call failed: ${message}. Verify the phone number id exists and the agent has telephony enabled.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "list_recent_calls",
      "Return summary of recent calls (status, duration, outcome).",
      { limit: z.number().int().min(1).max(50).default(10) },
      async ({ limit }) => {
        const logs = await listConversations(ctx.elevenlabs_agent_id, limit);
        return { content: [{ type: "text", text: JSON.stringify(logs) }] };
      },
    ),

    tool(
      "get_call_details",
      "Return transcript, recording URL, evaluation, and collected data for a conversation id.",
      { conversation_id: z.string().min(1) },
      async ({ conversation_id }) => {
        const detail = await getConversationDetail(conversation_id);
        return { content: [{ type: "text", text: JSON.stringify(detail) }] };
      },
    ),

    // ── Phone number import / CRUD ───────────────────────────────────────
    //
    // Credentials (Twilio SID/Auth Token, SIP creds) MUST be entered by
    // the user via the phone_number_setup widget — never passed into the
    // model. The setup_phone_number tool below renders that widget and
    // pauses; on resolve the server imports the number via the ElevenLabs
    // API and (by default) attaches it to this agent.

    tool(
      "setup_phone_number",
      "Open the phone-number import widget for the user. Renders a two-tab form (Twilio / SIP trunk) where the user enters the phone number, label, and credentials directly. DO NOT pass any credentials or numbers as arguments — the user types them. After calling, your turn ENDS; the platform resumes you with the import result.",
      {
        reason: z
          .string()
          .min(1)
          .max(300)
          .describe(
            "Short one-line explanation shown above the form, e.g. 'So this agent can answer inbound calls.'",
          ),
        default_provider: z.enum(["twilio", "sip_trunk"]).optional(),
        attach_after_import: z
          .boolean()
          .optional()
          .describe(
            "When true (default), attach the newly imported number to THIS agent automatically.",
          ),
      },
      async ({ reason, default_provider, attach_after_import }) => {
        try {
          const action_id = await createWidgetAction(ctx, "phone_number_setup", {
            reason,
            default_provider,
            attach_after_import,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Phone-number setup widget presented to the user (action_id=${action_id}). End your turn now; you will be resumed with the import result.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `setup_phone_number failed: ${message}.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "get_phone_number",
      "Fetch the full ElevenLabs configuration for a phone number id (provider, label, region/sip config, attached agent).",
      { phone_number_id: z.string().min(1) },
      async ({ phone_number_id }) => {
        const data = await getPhoneNumber(phone_number_id);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    ),

    tool(
      "update_phone_number",
      "Update mutable fields on a phone number (label, agent attachment, region/SIP configs). Pass only the fields you want to change. Use null on agent_id to detach.",
      {
        phone_number_id: z.string().min(1),
        label: z.string().min(1).max(120).optional(),
        agent_id: z
          .string()
          .nullable()
          .optional()
          .describe(
            "ElevenLabs agent id to attach this number to, or null to detach.",
          ),
        inbound_trunk_config: z.record(z.string(), z.unknown()).optional(),
        outbound_trunk_config: z.record(z.string(), z.unknown()).optional(),
      },
      async ({
        phone_number_id,
        label,
        agent_id,
        inbound_trunk_config,
        outbound_trunk_config,
      }) =>
        runToolStep(ctx, "phone", "update_phone_number", async () => {
          await updatePhoneNumber(phone_number_id, {
            label,
            agent_id: agent_id ?? undefined,
            inbound_trunk_config: inbound_trunk_config as never,
            outbound_trunk_config: outbound_trunk_config as never,
          });
          // Re-derive this agent's attached set from ElevenLabs. update can
          // reassign or detach a number, so we can't just patch the cached
          // row in place — we need the new owner relationship.
          const attached: PhoneNumber[] = await listPhoneNumbersForAgent(
            ctx.elevenlabs_agent_id,
          );
          return {
            patch: { phone_numbers: attached },
            summary: `Updated phone number ${phone_number_id}.`,
          };
        }),
    ),

    tool(
      "delete_phone_number",
      "Permanently delete a phone number from the workspace. This is irreversible — confirm with the user first via a 'confirm' widget if you're unsure.",
      { phone_number_id: z.string().min(1) },
      async ({ phone_number_id }) =>
        runToolStep(ctx, "phone", "delete_phone_number", async () => {
          await deletePhoneNumber(phone_number_id);
          const remaining = ctx.config.phone_numbers.filter(
            (p) => p.id !== phone_number_id,
          );
          return {
            patch: { phone_numbers: remaining },
            summary: `Deleted phone number ${phone_number_id}.`,
          };
        }),
    ),

    tool(
      "get_phone_number_sip_messages",
      "Fetch the recent SIP signalling log for a sip_trunk-provider phone number. Use this to diagnose call setup or authentication failures. Returns an error if the number is not a SIP trunk.",
      { phone_number_id: z.string().min(1) },
      async ({ phone_number_id }) => {
        const data = await getPhoneNumberSipMessages(phone_number_id);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    ),
  ],
};
