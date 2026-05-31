/**
 * Alta built-in provider. Tools here read internal data (Mongo / our own
 * ElevenLabs API helpers) and use the function-typed `execute` path, so
 * they don't pay for an HTTP round-trip through our own Vercel function.
 *
 * The provider is always "connected" — there's no integration row to
 * provision, no OAuth, no per-workspace credentials. The dispatcher
 * branches on `execute`, so `path` is informational only (the `alta://`
 * scheme makes it obvious in logs that no HTTP is being made).
 */
import type { IntegrationProvider } from "../types";
import { ALTA_PROSPECT_FACTS } from "./tools/prospect_facts";
import { ALTA_CALL_HISTORY } from "./tools/call_history";
import { ALTA_LAST_CALL_SUMMARY } from "./tools/last_call_summary";
import { ALTA_LOCAL_TIME } from "./tools/local_time";
import { ALTA_AUDIENCE_CONTEXT } from "./tools/audience_context";

export const ALTA_PROVIDER: IntegrationProvider = {
  id: "alta",
  name: "Alta",
  description:
    "Built-in tools that surface data we already have — prospect facts from PDL, prior-call memory, audience context, caller local time. No external network or credentials needed.",
  icon: "✨",
  base_api_url: "alta://internal",
  oauth: {
    authorize_url: "",
    token_url: "",
    scopes: [],
  },
  // No OAuth, no proxy_secret. The dispatcher hits each tool's `execute`
  // function directly — never an outbound HTTP call. Treated as always
  // connected by the catalog + the install path.
  always_connected: true,
  runtime_tools: [
    ALTA_PROSPECT_FACTS,
    ALTA_CALL_HISTORY,
    ALTA_LAST_CALL_SUMMARY,
    ALTA_LOCAL_TIME,
    ALTA_AUDIENCE_CONTEXT,
  ],
};
