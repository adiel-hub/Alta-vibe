import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  cancelBatchCall,
  getBatchCall,
  submitBatchCall,
} from "@/lib/elevenlabs/client";
import type { Capability } from "./types";

/**
 * Batch outbound campaigns: place N calls in parallel with per-recipient
 * dynamic variables, a target concurrency limit, and optional scheduling.
 * Maps to /v1/convai/batch-calling/*.
 */
export const batchCallingCapability: Capability = {
  id: "batch_calling",
  label: "Batch calling",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "submit_batch_call_campaign",
      "Place a batch of outbound calls. Each recipient can carry per-call dynamic variables (e.g. {{customer_name}}, {{order_id}}). target_concurrency_limit caps simultaneous calls. scheduled_time_unix lets the campaign fire later. Requires a phone number attached to the agent.",
      {
        call_name: z.string().min(1).max(120),
        agent_phone_number_id: z.string().min(1),
        recipients: z
          .array(
            z.object({
              phone_number: z
                .string()
                .regex(/^\+?[0-9 \-()]{6,20}$/, "invalid phone number"),
              dynamic_variables: z.record(z.string(), z.string()).optional(),
            }),
          )
          .min(1)
          .max(10_000),
        scheduled_time_unix: z.number().int().optional(),
        target_concurrency_limit: z.number().int().min(1).max(500).optional(),
      },
      async (input) => {
        try {
          const { id } = await submitBatchCall({
            call_name: input.call_name,
            agent_id: ctx.elevenlabs_agent_id,
            agent_phone_number_id: input.agent_phone_number_id,
            recipients: input.recipients,
            scheduled_time_unix: input.scheduled_time_unix,
            target_concurrency_limit: input.target_concurrency_limit,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Batch "${input.call_name}" submitted with ${input.recipients.length} recipients. batch_id=${id}.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `submit_batch_call_campaign failed: ${message}. Verify the agent has telephony enabled and the phone number is attached.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "get_batch_call_status",
      "Return the status of a submitted batch (queued / running / completed counts).",
      { batch_id: z.string().min(1) },
      async ({ batch_id }) => {
        try {
          const result = await getBatchCall(batch_id);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              { type: "text" as const, text: `get_batch_call_status failed: ${message}` },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "cancel_batch_call_campaign",
      "Cancel a queued or running batch campaign. In-flight calls finish; pending recipients are skipped.",
      { batch_id: z.string().min(1) },
      async ({ batch_id }) => {
        try {
          await cancelBatchCall(batch_id);
          return {
            content: [{ type: "text" as const, text: `Batch ${batch_id} cancelled.` }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              { type: "text" as const, text: `cancel_batch_call failed: ${message}` },
            ],
            isError: true,
          };
        }
      },
    ),
  ],
};
