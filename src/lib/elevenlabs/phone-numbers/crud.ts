import { elFetch } from "../core/fetch";
import type { UpdatePhoneNumberInput } from "./types";

export async function getPhoneNumber(phoneNumberId: string): Promise<unknown> {
  const res = await elFetch(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "GET",
    section: "phone",
  });
  return res.json();
}

export async function deletePhoneNumber(phoneNumberId: string): Promise<void> {
  await elFetch(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "DELETE",
    section: "phone",
  });
}

export async function updatePhoneNumber(
  phoneNumberId: string,
  input: UpdatePhoneNumberInput,
): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (input.label !== undefined) body.label = input.label;
  if (input.agent_id !== undefined) body.agent_id = input.agent_id;
  if (input.region_config !== undefined) body.region_config = input.region_config;
  if (input.inbound_trunk_config !== undefined)
    body.inbound_trunk_config = input.inbound_trunk_config;
  if (input.outbound_trunk_config !== undefined)
    body.outbound_trunk_config = input.outbound_trunk_config;
  const res = await elFetch(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "PATCH",
    section: "phone",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * GET /v1/convai/phone-numbers/{id}/sip-messages — only valid for
 * sip_trunk-provider numbers. Returns the recent SIP signalling log so
 * operators can diagnose call setup / auth issues.
 */
export async function getPhoneNumberSipMessages(
  phoneNumberId: string,
): Promise<unknown> {
  const res = await elFetch(
    `/v1/convai/phone-numbers/${phoneNumberId}/sip-messages`,
    { method: "GET", section: "phone" },
  );
  return res.json();
}
