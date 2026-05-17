import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  assignPhoneNumberToAgent,
  getConversationDetail,
  initiateOutboundCall,
  listConversations,
  listPhoneNumbers,
} from "@/lib/elevenlabs/client";
import type { PhoneNumber } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

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
          const existing = ctx.config.phone_numbers.find((p) => p.id === phone_number_id);
          const numbers: PhoneNumber[] = existing
            ? ctx.config.phone_numbers
            : [
                ...ctx.config.phone_numbers,
                { id: phone_number_id, number: "(assigned)", provider: "unknown" },
              ];
          return { patch: { phone_numbers: numbers }, summary: "Phone number attached." };
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
  ],
};
