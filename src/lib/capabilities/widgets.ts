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
import type { WidgetKind } from "@/types/agent";
import type { Capability, ToolContext } from "./types";

/**
 * Create a widget_actions row, emit a `widget_inserted` SSE event, and return
 * the resulting action_id. Shared by `request_user_action` and any other
 * capability tool that wants to render its own interactive widget (e.g.
 * telephony's `setup_phone_number`). Payload should already be parsed/typed by
 * the caller — this helper does NOT validate shape.
 */
export async function createWidgetAction(
  ctx: ToolContext,
  kind: WidgetKind,
  payload: unknown,
): Promise<string> {
  const widgets = await widgetActionsCol();
  const doc = await widgets.insertOne({
    agent_id: new ObjectId(ctx.agentMongoId),
    turn_job_id: ctx.turn_job_id ? new ObjectId(ctx.turn_job_id) : null,
    kind,
    payload,
    status: "pending",
    result: null,
    created_at: new Date(),
    resolved_at: null,
  } as never);
  const action_id = doc.insertedId.toHexString();
  ctx.emit({ type: "widget_inserted", action_id, kind, payload });
  return action_id;
}

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

const PickOptionQuestion = z.object({
  question: z.string().min(1).max(300),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        /** Optional one-line context shown below the label. */
        description: z.string().optional(),
      }),
    )
    .min(2)
    .max(8),
  /** Allow selecting more than one option. Defaults to single-select. */
  multi: z.boolean().optional(),
});

// Two shapes are accepted for backwards compatibility:
//   1. Legacy single-question:   { question, options, multi? }
//      → resolves with         { value } or { values }
//   2. Multi-question wizard:    { questions: [{ question, options, multi? }, ...] }
//      → resolves with         { answers: [{ value } | { values }, ...] } (order-preserved)
// The widget UI walks the user through `questions` one at a time in a
// single card — same shell, with a small step indicator and Next/Confirm
// navigation between them.
const PickOptionPayload = z.union([
  PickOptionQuestion,
  z.object({
    questions: z.array(PickOptionQuestion).min(1).max(6),
  }),
]);

/**
 * Phone-number import widget. Renders a two-tab card in the chat (Twilio /
 * SIP trunk) so the user can paste the credentials needed to import the
 * number into ElevenLabs. We do NOT take any credentials from the agent —
 * the user types them directly into the widget so secrets never pass through
 * the model.
 */
const PhoneNumberSetupPayload = z.object({
  /** Optional default provider tab to show first. */
  default_provider: z.enum(["twilio", "sip_trunk"]).optional(),
  /**
   * Short one-line reason shown above the form ("So the agent can take
   * inbound calls on this number…"). Helps the user understand why they're
   * being prompted.
   */
  reason: z.string().min(1).max(300),
  /**
   * Whether to auto-attach the imported number to this agent after import.
   * Defaults to true — the common case is "set up a number for this agent".
   */
  attach_after_import: z.boolean().optional(),
});

/**
 * Free-form credential collection. Use when the agent is building a tool for
 * a system we don't have a first-party provider entry for (an unknown CRM,
 * a webhook signing secret, etc.) and needs the user to paste a value that
 * the generated tool will reference later.
 *
 * `name` is the stable handle the agent will reference from tool code
 * (`secrets.get("<name>")`). `description` is the user-facing explainer.
 */
const CollectSecretPayload = z.object({
  /** snake_case handle the agent will reference from tool code. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "name must be snake_case ascii"),
  /** Short human-readable label shown above the input. */
  title: z.string().min(1).max(80),
  /** Why we need it + where to find it. Markdown not rendered — keep plain. */
  description: z.string().min(1).max(500),
  /** Placeholder hint in the input. */
  placeholder: z.string().max(120).optional(),
  /** Optional "where do I get this?" link. */
  docs_url: z.string().url().optional(),
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
      "Show an interactive widget in the chat and PAUSE waiting for the user's response. THIS IS THE ONLY WAY to ask the user a question — do NOT use any built-in 'AskUserQuestion' tool, it is not wired into this chat. `kind` selects the widget; `payload` is the widget-specific JSON OBJECT (never a string). Kinds: (a) 'connect_integration' — payload: { provider, reason } — OAuth/PAT for a known provider (HubSpot, Slack, etc.). (b) 'confirm' — payload: { question, confirm_label?, cancel_label? } — yes/no confirmation, typically before destructive actions. (c) 'pick_option' — payload (two shapes): SINGLE question → { question, options: [{ value, label, description? }], multi?: boolean }, returns { value: string } or { values: string[] } when multi=true. MULTI-QUESTION wizard → { questions: [{ question, options, multi? }, ...] } (1–6 questions), returns { answers: [{ value } | { values }, ...] } in the same order; the widget walks the user through them one at a time in a single card. Each option may have a one-line `description` for context. (d) 'collect_secret' — payload: { name, title, description, placeholder?, docs_url? } — collect an arbitrary credential (API key, signing secret, webhook URL) for a system that ISN'T in the providers list. Use this when building a custom runtime tool that needs auth for an unknown third-party service. `name` is a snake_case handle the generated tool will reference (e.g. 'closepush_api_key'). The value is encrypted at rest and NEVER returned to you — you only see that it was saved. (e) 'phone_number_setup' — payload: { reason, default_provider?: 'twilio' | 'sip_trunk', attach_after_import?: boolean } — render a two-tab form (Twilio / SIP trunk) so the user can import a phone number into ElevenLabs. The user types the phone number, label, and credentials themselves — DO NOT pass any credentials or numbers in the payload. If `attach_after_import` is omitted it defaults to true (number is attached to this agent after import). After calling, your turn ENDS — the platform will resume your loop with the user's response.",
      {
        kind: z.enum([
          "connect_integration",
          "confirm",
          "pick_option",
          "collect_secret",
          "phone_number_setup",
        ]),
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
              // fall through; the per-kind parse below will surface a
              // typed error.
            }
          }
          let parsedPayload: unknown;
          if (kind === "connect_integration") {
            parsedPayload = ConnectIntegrationPayload.parse(raw);
          } else if (kind === "confirm") {
            parsedPayload = ConfirmPayload.parse(raw);
          } else if (kind === "pick_option") {
            parsedPayload = PickOptionPayload.parse(raw);
          } else if (kind === "phone_number_setup") {
            parsedPayload = PhoneNumberSetupPayload.parse(raw);
          } else {
            parsedPayload = CollectSecretPayload.parse(raw);
          }

          const action_id = await createWidgetAction(ctx, kind, parsedPayload);

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
