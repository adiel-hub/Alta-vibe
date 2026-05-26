import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { Capability } from "../types";
import { runToolStep } from "../types";

/**
 * Turn-detection settings — how the agent decides the user is done speaking.
 * Maps to `conversation_config.turn` on the wire.
 */
export const turnDetectionCapability: Capability = {
  id: "turn",
  label: "Turn detection",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "update_turn_detection",
      "Tune how the agent handles silence and interruptions. turn_timeout: seconds of silence before re-engaging the user (default 7). initial_wait_time: seconds to wait for the user to start if first_message is empty. silence_end_call_timeout: seconds before auto-hangup (default 20). turn_eagerness: 'low' (waits longer), 'standard' (default), 'high' (responds sooner). speculative_turn: pre-generate the response during user silence to reduce perceived latency (costs more in LLM tokens). Pass only fields to change.",
      {
        turn_timeout: z.number().min(1).max(60).optional(),
        initial_wait_time: z.number().min(1).max(60).optional(),
        silence_end_call_timeout: z.number().min(5).max(300).optional(),
        turn_eagerness: z.enum(["low", "standard", "high"]).optional(),
        speculative_turn: z.boolean().optional(),
      },
      async (input) =>
        runToolStep(ctx, "turn", "update_turn_detection", async () => {
          const summary = Object.entries(input)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          return {
            patch: {},
            upstreamPatch: input,
            summary: `Turn detection updated (${summary}).`,
          };
        }),
    ),
  ],
};
