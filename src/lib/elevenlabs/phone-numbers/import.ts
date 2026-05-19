import { elFetch } from "../core/fetch";
import type {
  ImportSIPTrunkPhoneNumberInput,
  ImportTwilioPhoneNumberInput,
} from "./types";

export async function importTwilioPhoneNumber(
  input: ImportTwilioPhoneNumberInput,
): Promise<{ phone_number_id: string }> {
  const body = {
    provider: "twilio" as const,
    phone_number: input.phone_number,
    label: input.label,
    sid: input.sid,
    token: input.token,
    ...(input.region_config ? { region_config: input.region_config } : {}),
  };
  const res = await elFetch("/v1/convai/phone-numbers", {
    method: "POST",
    section: "phone",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { phone_number_id: string };
}

export async function importSIPTrunkPhoneNumber(
  input: ImportSIPTrunkPhoneNumberInput,
): Promise<{ phone_number_id: string }> {
  const body: Record<string, unknown> = {
    provider: "sip_trunk",
    phone_number: input.phone_number,
    label: input.label,
  };
  if (input.inbound_trunk_config !== undefined) {
    body.inbound_trunk_config = input.inbound_trunk_config;
  }
  if (input.outbound_trunk_config !== undefined) {
    body.outbound_trunk_config = input.outbound_trunk_config;
  }
  const res = await elFetch("/v1/convai/phone-numbers", {
    method: "POST",
    section: "phone",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { phone_number_id: string };
}
