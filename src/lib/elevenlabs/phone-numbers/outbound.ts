import { elFetch } from "../core/fetch";

export async function initiateOutboundCall(input: {
  agentId: string;
  agentPhoneNumberId: string;
  toNumber: string;
  /**
   * Per-call dynamic variable values, populated from CRM pre-call
   * enrichment. The agent's system prompt references these as
   * `{{caller_name}}`, `{{caller_company}}` etc.; ElevenLabs substitutes
   * them at conversation start. Empty/missing values render as empty
   * strings (the agent treats the caller as new).
   */
  dynamicVariables?: Record<string, string>;
}): Promise<{ conversation_id: string }> {
  const body: Record<string, unknown> = {
    agent_id: input.agentId,
    agent_phone_number_id: input.agentPhoneNumberId,
    to_number: input.toNumber,
  };
  if (input.dynamicVariables && Object.keys(input.dynamicVariables).length > 0) {
    body.conversation_initiation_client_data = {
      dynamic_variables: input.dynamicVariables,
    };
  }
  const res = await elFetch(`/v1/convai/twilio/outbound-call`, {
    method: "POST",
    section: "outbound_call",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { conversation_id: string };
}
