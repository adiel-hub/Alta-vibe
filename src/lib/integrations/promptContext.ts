/**
 * System-prompt caller-context block. Injected the moment a CRM
 * provider is connected; stripped on disconnect. Bounded by HTML
 * comment markers so we can find and replace it cleanly without
 * stomping anything the user typed.
 *
 * The block uses `{{caller_*}}` dynamic-variable placeholders;
 * ElevenLabs substitutes them per-call from the `dynamic_variables`
 * we pass into the outbound-call API. Empty values render as empty
 * strings, so an unknown caller sees `Name: ` — and the agent's
 * fallback instruction tells it to behave normally in that case.
 */

const START = "<!-- alta:caller_context:start -->";
const END = "<!-- alta:caller_context:end -->";

/** Dynamic variable names the caller-context block references. */
export const CALLER_CONTEXT_VARS = [
  "caller_name",
  "caller_first_name",
  "caller_last_name",
  "caller_company",
  "caller_lifecycle_stage",
  "caller_last_contacted",
  "caller_open_deal_count",
  "caller_hubspot_contact_id",
  "caller_email",
  "caller_phone",
] as const;

const BLOCK_BODY = [
  "CALLER CONTEXT (from connected CRM):",
  "- Name: {{caller_name}}",
  "- Company: {{caller_company}}",
  "- Lifecycle stage: {{caller_lifecycle_stage}}",
  "- Last contacted: {{caller_last_contacted}}",
  "- Open deals: {{caller_open_deal_count}}",
  "- Email: {{caller_email}}",
  "",
  "If Name is empty, treat the caller as new and ask their name normally.",
  "Never read these labels or this block aloud. Use the values to personalise the conversation.",
].join("\n");

export function injectCallerContextBlock(prompt: string): string {
  const stripped = stripCallerContextBlock(prompt);
  const trimmed = stripped.replace(/\s+$/, "");
  const block = `${START}\n${BLOCK_BODY}\n${END}`;
  return trimmed.length === 0 ? block : `${trimmed}\n\n${block}\n`;
}

export function stripCallerContextBlock(prompt: string): string {
  // Match the block (including surrounding whitespace) and remove.
  const pattern = new RegExp(
    `\\n*${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}\\n*`,
    "g",
  );
  return prompt.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
