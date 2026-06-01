/**
 * Integration provider registry. Each provider declares:
 *   - identity (id, name, description)
 *   - a catalog of runtime tool specs the agent can install (e.g. HubSpot →
 *     create_contact, find_contact_by_email, log_call, …). All tools are
 *     opt-in via the Tools tab or the `install_provider_tool` capability.
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
 *
 * Pre-call tools: exactly one of `execute` (function-typed, internal data)
 * or `build_body` (HTTP-typed, external upstream) must be set. `execute`
 * runs in-process; `build_body` constructs the HTTP body that gets POSTed
 * through the proxy. Both receive the CallerContext and the merged outputs
 * from earlier waves. `output_aliases` projects scalar JSON paths into
 * flat dynamic-variable names. In-call tools use neither — the LLM builds
 * bodies from the schema, and ElevenLabs handles responses.
 */
import type { RuntimePhase } from "@/types/agent";
import type { CallerContext } from "@/lib/calls/callerContext";

/** Merged dynamic-variables map produced by earlier waves; read by later tools. */
export type PriorOutputs = Readonly<Record<string, string>>;

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
  /** UI grouping label (e.g. "Contacts", "Deals"). */
  category?: string;

  // ── pre-call execution (exactly one required for phase: pre_call) ─────
  /**
   * Function-typed execution. Use for tools that read our DB, fetch from
   * the ElevenLabs API, or compute derived values — anything that
   * shouldn't pay for an HTTP round-trip through our own Vercel function.
   * `prior` is the merged output map from earlier waves. Return `null` to
   * contribute nothing (the "no data available" case, not an error).
   */
  execute?: (
    ctx: CallerContext,
    prior: PriorOutputs,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * HTTP-typed execution. The dispatcher templates the returned body and
   * POSTs it through the proxy to `tool.url`. Return `null` to skip the
   * HTTP call entirely (use this for conditional fire-or-skip decisions).
   */
  build_body?: (
    ctx: CallerContext,
    prior: PriorOutputs,
  ) => Record<string, unknown> | null;

  // ── pre-call output projection ────────────────────────────────────────
  /**
   * Project response JSON paths into flat dynamic-variable names. Keys
   * become variable names exposed to the conversation. Values are dot-paths
   * (e.g. "results.0.properties.firstname"). Missing paths produce no
   * variable (not an empty string).
   */
  output_aliases?: Record<string, string>;
  /**
   * Optional one-line narrative summarizing this tool's findings. Joined
   * across all tools into `{{caller_context_summary}}`. Return `null` if
   * the tool has nothing meaningful to say (cold prospect, empty result).
   */
  narrative?: (ctx: CallerContext, output: unknown) => string | null;

  // ── pre-call execution control ────────────────────────────────────────
  /**
   * Variable names this tool requires in the merged context before it can
   * run. Dispatched in waves: a tool runs only when ALL its needs are
   * present. Empty/missing = wave 1.
   */
  needs?: string[];
  /**
   * Per-tool timeout in ms. Default 5000. HTTP tools get an
   * AbortController; function tools get a Promise.race.
   */
  timeout_ms?: number;
  /**
   * When true, a failure (timeout, error, non-2xx, or rejected promise)
   * aborts the entire pre-call dispatch and prevents the call from being
   * placed. Use for compliance gates and DNC checks.
   */
  abort_on_failure?: boolean;
  /**
   * Priority for variable-collision resolution. When two tools emit the
   * same variable name, the higher priority wins. Tie = last-write.
   * Default 0.
   */
  priority?: number;

  /**
   * Opt-in marker for per-agent custom field mappings (see
   * ToolBinding.field_mappings). When present, the UI shows a mapping editor
   * for this tool and enrichment augments `build_body` (requesting the extra
   * properties) and `output_aliases` (projecting them into variables) from
   * the binding's mappings. Only meaningful for HTTP-typed pre-call tools.
   */
  field_mapping?: {
    /** Which provider object's properties to list in the picker (e.g. "contacts"). */
    object: string;
    /** Body key holding the requested-properties array. Default "properties". */
    request_properties_key?: string;
    /**
     * Template for the response JSON path of a mapped property, with
     * `{property}` substituted (e.g. "results.0.properties.{property}").
     */
    output_path_template: string;
  };
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
  /**
   * Built-in providers whose tools read internal platform data (our DB,
   * the user's workspace context, etc.) — they need no OAuth, no
   * proxy_secret, no per-workspace credentials. Marked here so the UI
   * skips the "Connect" affordance, the catalog reports them as
   * connected by default, and the install path doesn't try to look up
   * a non-existent `integrations` row.
   */
  always_connected?: boolean;
};
