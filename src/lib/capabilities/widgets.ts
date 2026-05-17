/**
 * Widget capability — lets the agent ask the user to do something interactive
 * in the chat (connect an integration, confirm an action, pick from options).
 *
 * Flow:
 *   1. Agent calls `request_user_action` with a widget spec.
 *   2. We create a `widget_actions` doc with status='pending', emit a
 *      `widget_inserted` event so the chat panel renders the interactive
 *      widget alongside the tool_use block.
 *   3. Tool returns a result with the action_id so the agent knows it must
 *      stop and wait. The agent's turn ENDS here.
 *   4. User interacts (clicks Connect, picks an option, etc). Browser POSTs
 *      to `/api/agents/[id]/widgets/[actionId]/resolve`.
 *   5. The resolve endpoint marks the action done, runs any side-effects
 *      (e.g. registers integration runtime tools), and enqueues a new turn
 *      with a synthetic user message "[widget result] ..." so the agent
 *      continues its loop.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { widgetActionsCol } from "@/lib/mongodb";
import { PROVIDERS } from "@/lib/integrations/providers";
import type { Capability } from "./types";

const ConnectIntegrationPayload = z.object({
  provider: z
    .string()
    .refine(
      (v) => PROVIDERS.some((p) => p.id === v),
      "unknown provider — call list_integration_providers first",
    ),
  reason: z.string().min(1).max(300),
});

const ConfirmPayload = z.object({
  question: z.string().min(1).max(300),
  confirm_label: z.string().optional(),
  cancel_label: z.string().optional(),
});

const PickOptionPayload = z.object({
  question: z.string().min(1).max(300),
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .min(2)
    .max(6),
});

export const widgetsCapability: Capability = {
  id: "widgets",
  label: "Interactive widgets",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "list_integration_providers",
      "List third-party providers the user can connect (HubSpot, Slack, etc.). Always call this before request_user_action with kind='connect_integration'.",
      {},
      async () => {
        const data = PROVIDERS.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          icon: p.icon,
          tools_provided: p.runtime_tools.map((t) => t.name),
        }));
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    ),

    tool(
      "request_user_action",
      "Show an interactive widget in the chat and PAUSE waiting for the user's response. Use this when you need the user to (a) connect a third-party integration via OAuth — `payload` is an OBJECT: { provider_id: '<id>', reason: '<one line>' }; (b) confirm a destructive action — payload: { title, body, confirm_label?, destructive? }; or (c) pick from a small set of options — payload: { question, options: [{ id, label }] }. The `payload` argument MUST be a JSON OBJECT, not a string. After calling, your turn ends — the platform will resume your loop with the user's response.",
      {
        kind: z.enum(["connect_integration", "confirm", "pick_option"]),
        payload: z.record(z.string(), z.unknown()),
      },
      async ({ kind, payload }) => {
        try {
          // Defensive: some models stringify nested objects when the schema
          // isn't explicit about shape. Accept either object or
          // JSON-stringified object so the agent doesn't get stuck retrying.
          let raw: unknown = payload;
          if (typeof raw === "string") {
            try {
              raw = JSON.parse(raw);
            } catch {
              // fall through; ConnectIntegrationPayload.parse will surface
              // a typed error.
            }
          }
          let parsedPayload: unknown;
          if (kind === "connect_integration") {
            parsedPayload = ConnectIntegrationPayload.parse(raw);
          } else if (kind === "confirm") {
            parsedPayload = ConfirmPayload.parse(raw);
          } else {
            parsedPayload = PickOptionPayload.parse(raw);
          }

          const widgets = await widgetActionsCol();
          const doc = await widgets.insertOne({
            agent_id: new ObjectId(ctx.agentMongoId),
            turn_job_id: ctx.turn_job_id
              ? new ObjectId(ctx.turn_job_id)
              : null,
            kind,
            payload: parsedPayload,
            status: "pending",
            result: null,
            created_at: new Date(),
            resolved_at: null,
          } as never);
          const action_id = doc.insertedId.toHexString();

          ctx.emit({
            type: "widget_inserted",
            action_id,
            kind,
            payload: parsedPayload,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `Widget "${kind}" presented to the user (action_id=${action_id}). End your turn now; you will be resumed with the user's response.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `request_user_action failed: ${message}. Re-check the payload shape and retry.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  ],
};
