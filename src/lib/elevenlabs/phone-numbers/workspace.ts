import type { PhoneNumber } from "@/types/agent";
import { elFetch } from "../core/fetch";
import type { WorkspacePhoneNumber } from "./types";

export async function listPhoneNumbers(): Promise<WorkspacePhoneNumber[]> {
  const res = await elFetch("/v1/convai/phone-numbers", {
    method: "GET",
    section: "phone",
  });
  const json = (await res.json()) as Array<{
    phone_number_id: string;
    phone_number: string;
    provider: string;
    label?: string;
    assigned_agent?: {
      agent_id?: string;
      agent_name?: string;
    } | null;
  }>;
  return json.map((p) => ({
    id: p.phone_number_id,
    number: p.phone_number,
    provider: p.provider,
    label: p.label,
    assigned_agent_id: p.assigned_agent?.agent_id ?? null,
    assigned_agent_name: p.assigned_agent?.agent_name ?? null,
  }));
}

/**
 * Subset of `listPhoneNumbers` filtered to numbers currently assigned to a
 * specific ElevenLabs agent id. We can't trust the GET-agent response to
 * include `phone_numbers` — depending on workspace settings ElevenLabs
 * omits it — so the workspace list is the source of truth.
 */
export async function listPhoneNumbersForAgent(
  elevenlabsAgentId: string,
): Promise<PhoneNumber[]> {
  const all = await listPhoneNumbers();
  return all
    .filter((p) => p.assigned_agent_id === elevenlabsAgentId)
    .map((p) => ({
      id: p.id,
      number: p.number,
      provider: p.provider,
      label: p.label,
    }));
}

export async function assignPhoneNumberToAgent(
  phoneNumberId: string,
  agentId: string,
): Promise<void> {
  await elFetch(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "PATCH",
    section: "phone",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
}
