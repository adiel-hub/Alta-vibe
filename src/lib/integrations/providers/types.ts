/**
 * Integration provider registry. Each provider declares:
 *   - identity (id, name, description)
 *   - a catalog of runtime tool specs the agent can install (e.g. HubSpot →
 *     create_contact, find_contact_by_email, log_call, …). Tools marked
 *     `default_install` are wired up automatically the moment the provider
 *     connects; the rest are opt-in via the Tools tab or the
 *     `install_provider_tool` capability.
 *   - OAuth metadata (placeholder; v1 uses paste-a-PAT).
 *
 * Schemas: each tool carries its own JSON-schema for body and/or query so
 * ElevenLabs can describe to the LLM exactly what shape to produce. The
 * proxy forwards whatever ElevenLabs sends, so the schema is the contract.
 *
 * Path templates: HubSpot routes like /crm/v3/objects/contacts/{contactId}
 * expect the id in the URL. Tools with `path_template: true` get those
 * `{var}` placeholders substituted from request body keys at proxy time —
 * the substituted keys are stripped from the forwarded body so HubSpot
 * doesn't see them as unknown properties.
 */
import type { RuntimePhase } from "@/types/agent";

export type ProviderRuntimeToolSpec = {
  /** Stable handle, distinct from the phase-scoped tool name used on ElevenLabs. */
  key: string;
  /** Tool name as it appears on ElevenLabs (pre/post-call get phase-prefixed at install time). */
  name: string;
  description: string;
  phase: RuntimePhase;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Relative path; full URL = provider.base_api_url + path (after template substitution). */
  path: string;
  /** When true, the proxy substitutes `{var}` placeholders in `path` from the request body. */
  path_template?: boolean;
  /** Optional JSON-Schema for the request body (forwarded to ElevenLabs as request_body_schema). */
  body_schema?: Record<string, unknown>;
  /** Optional JSON-Schema for query params (forwarded as query_params_schema). */
  query_schema?: Record<string, unknown>;
  /** Auto-install when the provider connects. Defaults to false. */
  default_install?: boolean;
  /** UI grouping label (e.g. "Contacts", "Deals"). */
  category?: string;
};

export type IntegrationProvider = {
  id: string;
  name: string;
  description: string;
  icon: string;
  base_api_url: string;
  oauth: {
    authorize_url: string;
    token_url: string;
    scopes: string[];
  };
  runtime_tools: ProviderRuntimeToolSpec[];
};
