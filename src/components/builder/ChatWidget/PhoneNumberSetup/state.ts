// Two tabs (Twilio / SIP trunk), matching the ElevenLabs import endpoint's
// `oneOf` request body. The user types the number, label, and credentials
// themselves so secrets never pass through the agent.

export type TwilioFormState = {
  phone_number: string;
  label: string;
  sid: string;
  token: string;
};

export type SipFormState = {
  phone_number: string;
  label: string;
  outbound_address: string;
  outbound_transport: "auto" | "udp" | "tcp" | "tls";
  outbound_media_encryption: "disabled" | "allowed" | "required";
  username: string;
  password: string;
};

export const EMPTY_TWILIO: TwilioFormState = {
  phone_number: "",
  label: "",
  sid: "",
  token: "",
};

export const EMPTY_SIP: SipFormState = {
  phone_number: "",
  label: "",
  outbound_address: "",
  outbound_transport: "auto",
  outbound_media_encryption: "allowed",
  username: "",
  password: "",
};
