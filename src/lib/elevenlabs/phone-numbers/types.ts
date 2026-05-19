import type { PhoneNumber } from "@/types/agent";

/**
 * Workspace phone number row as returned by `GET /v1/convai/phone-numbers`.
 * Carries the `assigned_agent` field so callers can tell which agent (if
 * any) currently owns each number — needed to render the per-agent
 * "Attached phone numbers" list correctly without trusting the agent GET
 * response (which doesn't always echo `phone_numbers`).
 */
export type WorkspacePhoneNumber = PhoneNumber & {
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
};

// --- Phone number import / CRUD ---------------------------------------------
//
// Spec: https://elevenlabs.io/docs/api-reference/phone-numbers
// POST /v1/convai/phone-numbers accepts either a Twilio config or a SIP-trunk
// config (oneOf). Below we expose typed helpers for each shape so callers
// can't mix fields from both branches and trip a 422.

export type TwilioRegionId = "us1" | "ie1" | "au1";
export type TwilioEdgeLocation =
  | "ashburn"
  | "dublin"
  | "frankfurt"
  | "sao-paulo"
  | "singapore"
  | "sydney"
  | "tokyo"
  | "umatilla"
  | "roaming";

export type ImportTwilioPhoneNumberInput = {
  phone_number: string;
  label: string;
  sid: string;
  token: string;
  region_config?: {
    region_id: TwilioRegionId;
    token: string;
    edge_location: TwilioEdgeLocation;
  };
};

export type SIPMediaEncryption = "disabled" | "allowed" | "required";
export type SIPTransport = "auto" | "udp" | "tcp" | "tls";

export type SIPTrunkCredentials = {
  username: string;
  password?: string | null;
};

export type InboundSIPTrunkConfig = {
  allowed_addresses?: string[] | null;
  allowed_numbers?: string[] | null;
  media_encryption?: SIPMediaEncryption;
  credentials?: SIPTrunkCredentials | null;
  remote_domains?: string[] | null;
  attributes_to_headers?: Record<string, string>;
};

export type OutboundSIPTrunkConfig = {
  address: string;
  transport?: SIPTransport;
  media_encryption?: SIPMediaEncryption;
  headers?: Record<string, string>;
  attributes_to_headers?: Record<string, string>;
  credentials?: SIPTrunkCredentials | null;
};

export type ImportSIPTrunkPhoneNumberInput = {
  phone_number: string;
  label: string;
  inbound_trunk_config?: InboundSIPTrunkConfig | null;
  outbound_trunk_config?: OutboundSIPTrunkConfig | null;
};

/**
 * PATCH /v1/convai/phone-numbers/{id}. The endpoint also handles agent
 * assignment (see `assignPhoneNumberToAgent`); this helper exposes the
 * other mutable fields (label, region config, sip configs).
 */
export type UpdatePhoneNumberInput = {
  label?: string;
  agent_id?: string | null;
  region_config?: ImportTwilioPhoneNumberInput["region_config"] | null;
  inbound_trunk_config?: InboundSIPTrunkConfig | null;
  outbound_trunk_config?: OutboundSIPTrunkConfig | null;
};
