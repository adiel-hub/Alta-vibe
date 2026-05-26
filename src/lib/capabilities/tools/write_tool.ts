/**
 * The "make me a tool" capability. One MCP tool the builder agent calls
 * with a high-level intent; the platform synthesizes the webhook spec,
 * publishes it through the custom-tool proxy, and wires it onto the
 * ElevenLabs agent.
 *
 * Architecture (Tier 1 — webhook spec, no sandbox):
 *
 *   builder agent (Claude via Agent SDK)
 *      │
 *      ▼
 *   write_tool({ intent, phase, needs_secrets?, hints? })
 *      │
 *      ├─ Gate 1: check `agent_secrets` for every name in `needs_secrets`.
 *      │           if any missing → return { status: "needs_secrets", missing }.
 *      │           Builder fires collect_secret widgets, then re-calls write_tool.
 *      │
 *      ├─ Gate 2: synthesize the webhook spec via the Anthropic SDK with a
 *      │           focused prompt. Output is structured JSON describing the
 *      │           upstream URL, method, headers (templated with
 *      │           {{secret:name}}), and JSON-schema for body & query.
 *      │
 *      └─ Gate 3: persist to `custom_tools` with a fresh proxy_secret, register
 *                  the tool with ElevenLabs pointing at our proxy, patch the
 *                  agent's tool list. ElevenLabs only sees the proxy URL and a
 *                  bearer — never the user's third-party API key.
 *
 * At call time the proxy substitutes `{{secret:name}}` with decrypted
 * values from agent_secrets and forwards upstream. See
 * src/app/api/custom-tools/proxy/[agentId]/[customToolId]/route.ts.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { customToolsCol } from "@/lib/mongodb";
import { listAgentSecrets } from "@/lib/integrations/agentSecrets";
import {
  createRuntimeTool,
  deleteRuntimeTool,
} from "@/lib/elevenlabs/client";
import { externalToolIds, isLocalToolId } from "@/lib/elevenlabs/lifecycle/toolIds";
import {
  extractSecretRefs,
  normalizeElevenlabsSchema,
  scopeToolName,
} from "@/lib/integrations/schemaUtils";
import type {
  CustomToolDocument,
  RuntimePhase,
  RuntimeTool,
} from "@/types/agent";
import type { Capability } from "../types";
import { runToolStep } from "../types";

const SYNTH_MODEL = "claude-opus-4-7";
const SYNTH_MAX_TOKENS = 2000;

let cachedAnthropic: Anthropic | null = null;
function anthropic(): Anthropic {
  if (cachedAnthropic) return cachedAnthropic;
  cachedAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cachedAnthropic;
}

function getAppBaseUrl(): string {
  const url =
    process.env.APP_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "http://localhost:3000";
  return url.replace(/\/$/, "");
}

function collectSecretRefs(spec: SynthSpec): string[] {
  return extractSecretRefs([
    spec.upstream_url,
    ...Object.values(spec.headers ?? {}),
  ]);
}

const SYNTH_SYSTEM_PROMPT = `You are a JSON-only synthesizer that converts a user's plain-English description of a webhook tool into a structured ElevenLabs runtime tool spec.

You output EXACTLY ONE JSON object matching this shape (no markdown, no prose, no backticks):

{
  "name": "snake_case_name",
  "description": "One sentence the voice agent will read when deciding whether to call this tool.",
  "upstream_url": "https://api.<service>.com/path",
  "method": "GET" | "POST" | "PUT" | "DELETE",
  "headers": { "Header-Name": "value or {{secret:secret_name}} template" },
  "body_schema": <JSON-Schema object — OMIT THIS FIELD ENTIRELY if no body>,
  "query_schema": <JSON-Schema object — OMIT THIS FIELD ENTIRELY if no query params>
}

Rules:
  1. The "name" must be snake_case, ASCII, max 60 chars, descriptive of the action
     (e.g. "create_contact_in_closepush", "send_followup_email").
  2. The "description" is read by the voice model at call time to decide
     whether to invoke. Be specific about what the tool does and when to use it.
     One sentence, under 200 chars.
  3. Headers MUST reference credentials via the {{secret:<name>}} template, NEVER
     inline literal API keys. The user provides the list of available secret names —
     pick from that list. If a secret you need is not on the list, the platform will
     prompt the user for it on a follow-up turn; just reference it by an intuitive
     snake_case name (e.g. {{secret:closepush_api_key}}).
  4. Always include "Accept: application/json" unless the API requires something else.
     For POST/PUT, include "Content-Type: application/json" unless the API requires
     form-encoding.
  5. body_schema and query_schema use ElevenLabs-specific shapes that differ:
       - query_schema: { properties: {...}, required?: [...] }  — NO outer "type".
         Each property MUST be a literal type (string/integer/number/boolean) —
         no nested objects/arrays. Example:
            { "properties": { "ids": { "type": "string", "description": "Coin id" },
                              "vs_currencies": { "type": "string", "description": "Currency" } },
              "required": ["ids", "vs_currencies"] }
       - body_schema:  { "type": "object", "properties": {...}, "required"?: [...] }
         The outer "type": "object" IS required here. Properties may be nested
         objects/arrays. Example:
            { "type": "object",
              "properties": { "email": { "type": "string", "description": "Caller email" } },
              "required": ["email"] }
     If the request has no body, OMIT body_schema entirely (do NOT write "body_schema": null).
     Same for query_schema.
  6. NEVER include the user's first-party Bearer token, OAuth credential, or any
     hardcoded auth value. Auth is always a {{secret:...}} reference.
  7. If you cannot confidently produce a working spec from the intent, output:
     { "error": "<one-sentence explanation of what's missing>" }

Output ONLY the JSON object. No preamble, no markdown code fences, no commentary.`;

type SynthSpec = {
  name: string;
  description: string;
  upstream_url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body_schema?: unknown;
  query_schema?: unknown;
};

const SynthSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "name must be snake_case ascii"),
  description: z.string().min(1).max(500),
  upstream_url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  headers: z.record(z.string(), z.string()),
  body_schema: z.unknown().optional(),
  query_schema: z.unknown().optional(),
});

/**
 * Call Anthropic to turn an intent into a structured webhook spec. Returns
 * the parsed spec or throws an Error with a user-facing message.
 */
async function synthesizeSpec(input: {
  intent: string;
  phase: RuntimePhase;
  available_secret_names: string[];
  hints?: {
    docs_url?: string;
    base_url?: string;
    example_request?: string;
  };
}): Promise<SynthSpec> {
  const userMsg = [
    `INTENT: ${input.intent}`,
    "",
    `PHASE: ${input.phase} (when in the call lifecycle this tool fires)`,
    "",
    `AVAILABLE SECRETS (reference these as {{secret:<name>}} in headers):`,
    input.available_secret_names.length === 0
      ? "  (none yet — if you need one, reference it by an intuitive snake_case name and the platform will collect it on the next turn)"
      : input.available_secret_names.map((n) => `  - ${n}`).join("\n"),
    "",
    "HINTS:",
    input.hints?.base_url ? `  base_url: ${input.hints.base_url}` : "",
    input.hints?.docs_url ? `  docs_url: ${input.hints.docs_url}` : "",
    input.hints?.example_request
      ? `  example_request:\n${input.hints.example_request
          .split("\n")
          .map((l) => "    " + l)
          .join("\n")}`
      : "",
    "",
    "Produce the JSON spec now.",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await anthropic().messages.create({
    model: SYNTH_MODEL,
    max_tokens: SYNTH_MAX_TOKENS,
    system: SYNTH_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const raw = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // Strip code fences if the model wrapped them despite instructions.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `Spec synthesis returned non-JSON. First 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    typeof (parsed as { error: unknown }).error === "string"
  ) {
    throw new Error(
      `Spec synthesis couldn't produce a working tool: ${(parsed as { error: string }).error}`,
    );
  }

  const valid = SynthSpecSchema.safeParse(parsed);
  if (!valid.success) {
    throw new Error(
      `Spec synthesis returned an invalid shape: ${valid.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return valid.data;
}

export const writeToolCapability: Capability = {
  id: "write_tool",
  label: "Synthesize custom runtime tools",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "write_tool",
      "Synthesize a NEW runtime tool from a plain-English intent. Use this — NOT create_custom_runtime_tool — whenever the user wants the agent to do something during/after a call that isn't covered by a built-in or a connected provider. The platform turns the intent into a webhook spec, registers it with the voice platform, and routes all traffic through our secret-substituting proxy so third-party API keys never reach the voice platform.\n\nArgs:\n  - intent: one-paragraph description of what the tool should do and when.\n  - phase: 'pre_call' (before greeting), 'in_call' (during conversation), or 'post_call' (after hangup).\n  - needs_secrets (optional): credentials the tool will need, each with { name (snake_case handle), title, description (where to get it), placeholder?, docs_url? }. If any are not already saved, the response will be { status: 'needs_secrets', missing: [...] } — fire a request_user_action(kind='collect_secret') widget for EACH missing one, then call write_tool again with the same args.\n  - hints (optional): { docs_url, base_url, example_request } — anything the user told you about the target API. The synthesizer uses these to ground the URL and request shape.\n\nReturns either { status: 'needs_secrets', missing } (you must collect each then re-call) or { status: 'published', tool_id, name, phase, summary, request_preview } (the tool is live on the agent).",
      {
        intent: z.string().min(10).max(2000),
        phase: z.enum(["pre_call", "in_call", "post_call"]),
        needs_secrets: z
          .array(
            z.object({
              name: z
                .string()
                .min(1)
                .max(64)
                .regex(/^[a-z0-9_]+$/, "name must be snake_case ascii"),
              title: z.string().min(1).max(80),
              description: z.string().min(1).max(500),
              placeholder: z.string().max(120).optional(),
              docs_url: z.string().url().optional(),
            }),
          )
          .optional(),
        hints: z
          .object({
            docs_url: z.string().url().optional(),
            base_url: z.string().url().optional(),
            example_request: z.string().max(2000).optional(),
          })
          .optional(),
      },
      async ({ intent, phase, needs_secrets, hints }) =>
        runToolStep(ctx, "tools", "write_tool", async () => {
          // ── Gate 1: secret check ─────────────────────────────────────
          const declared = needs_secrets ?? [];
          const existing = await listAgentSecrets(ctx.agentMongoId);
          const existingNames = new Set(existing.map((s) => s.name));
          const missing = declared.filter((s) => !existingNames.has(s.name));
          if (missing.length > 0) {
            // Return WITHOUT patching state — the builder agent will fire
            // collect_secret widgets and re-call us. The summary is
            // JSON-encoded so the agent can parse it programmatically and
            // branch on `status` rather than relying on prose recognition.
            return {
              patch: {},
              summary: JSON.stringify({
                status: "needs_secrets",
                missing,
                next_step:
                  "Call request_user_action({ kind: 'collect_secret', payload: <each missing entry> }) for each missing secret, then re-call write_tool with the same arguments.",
              }),
            };
          }

          // ── Gate 2: synthesize the upstream spec ─────────────────────
          const synth = await synthesizeSpec({
            intent,
            phase,
            available_secret_names: Array.from(existingNames),
            hints,
          });
          const referencedSecrets = collectSecretRefs(synth);
          const stillMissing = referencedSecrets.filter(
            (n) => !existingNames.has(n),
          );
          if (stillMissing.length > 0) {
            // The synthesizer invented a secret name we don't have. Surface
            // that as a needs_secrets so the agent can collect them. We do
            // NOT publish a partial tool.
            return {
              patch: {},
              summary: JSON.stringify({
                status: "needs_secrets",
                missing: stillMissing.map((name) => ({
                  name,
                  title: prettify(name),
                  description: `Required by the tool '${synth.name}' (${synth.method} ${synth.upstream_url}). The synthesizer referenced it via {{secret:${name}}}.`,
                  docs_url: hints?.docs_url,
                })),
                next_step:
                  "The synthesizer referenced a secret you haven't collected yet. Fire collect_secret widgets for each, then re-call write_tool with the same arguments.",
              }),
            };
          }

          // ── Gate 3: persist + publish ────────────────────────────────
          const scopedName = scopeToolName(synth.name, phase);

          // Prevent name collisions with already-attached tools.
          if (ctx.config.tools.some((t) => t.name === scopedName)) {
            throw new Error(
              `A tool named "${scopedName}" already exists on this agent. Try a different intent or remove the existing tool first.`,
            );
          }

          // Insert the custom_tools doc up front so we have the _id we need
          // to point ElevenLabs at our proxy. If the createRuntimeTool call
          // fails afterwards, we delete the orphan row in the catch.
          const proxySecret = randomBytes(32).toString("hex");
          const tools = await customToolsCol();
          const now = new Date();
          const insertRes = await tools.insertOne({
            agent_id: new ObjectId(ctx.agentMongoId),
            name: scopedName,
            description: synth.description,
            phase,
            proxy_secret: proxySecret,
            elevenlabs_tool_id: "",
            upstream: {
              url: synth.upstream_url,
              method: synth.method,
              headers: synth.headers,
              body_schema: synth.body_schema,
              query_schema: synth.query_schema,
            },
            secret_refs: referencedSecrets,
            created_at: now,
            updated_at: now,
          } as Omit<CustomToolDocument, "_id"> as never);
          const customToolId = insertRes.insertedId.toHexString();

          // Lifecycle (pre/post) tools fire from our webhook dispatchers,
          // never from ElevenLabs — skip the upstream tool registration and
          // mint a local id. The custom_tools row + proxy URL still exist
          // because dispatch.ts reuses the same secret-substituting proxy.
          const isLifecycle = phase !== "in_call";
          let created: { id: string; name: string };
          try {
            if (isLifecycle) {
              created = {
                id: `local_${randomBytes(8).toString("hex")}`,
                name: scopedName,
              };
            } else {
              const proxyUrl = `${getAppBaseUrl()}/api/custom-tools/proxy/${ctx.agentMongoId}/${customToolId}`;
              // Build api_schema with only the fields ElevenLabs accepts —
              // explicitly omit schemas when the synthesizer returned null
              // or an empty object. Sending `request_body_schema: null`
              // produces a 422 on /v1/convai/tools.
              const apiSchema: {
                url: string;
                method: "GET" | "POST" | "PUT" | "DELETE";
                request_headers: Record<string, string>;
                request_body_schema?: unknown;
                query_params_schema?: unknown;
              } = {
                url: proxyUrl,
                method: synth.method,
                request_headers: {
                  Authorization: `Bearer ${proxySecret}`,
                },
              };
              const normalizedBody = normalizeElevenlabsSchema(
                synth.body_schema,
                "body",
              );
              if (normalizedBody !== undefined) {
                apiSchema.request_body_schema = normalizedBody;
              }
              const normalizedQuery = normalizeElevenlabsSchema(
                synth.query_schema,
                "query",
              );
              if (normalizedQuery !== undefined) {
                apiSchema.query_params_schema = normalizedQuery;
              }
              created = await createRuntimeTool({
                name: scopedName,
                description: synth.description,
                type: "webhook",
                phase,
                api_schema: apiSchema,
              });
            }
          } catch (err) {
            // Roll back the orphaned custom_tools row so we don't leave
            // proxy_secrets pointing at nothing.
            await tools
              .deleteOne({ _id: insertRes.insertedId })
              .catch(() => {});
            throw err;
          }

          await tools.updateOne(
            { _id: insertRes.insertedId },
            { $set: { elevenlabs_tool_id: created.id, updated_at: new Date() } },
          );

          const entry: RuntimeTool = {
            id: created.id,
            name: scopedName,
            type: "webhook",
            description: synth.description,
            phase,
            method: synth.method,
            url: `${getAppBaseUrl()}/api/custom-tools/proxy/${ctx.agentMongoId}/${customToolId}`,
          };
          const nextTools = [...ctx.config.tools, entry];

          return {
            patch: { tools: nextTools },
            // Lifecycle tools don't appear in upstream `tool_ids` — they're
            // fired by our own lifecycle webhooks. `skipUpstream` keeps the
            // turn's deferred PATCH unchanged for that case.
            upstreamPatch: { tool_ids: externalToolIds(nextTools) },
            skipUpstream: isLifecycle,
            summary: JSON.stringify({
              status: "published",
              tool_id: created.id,
              name: scopedName,
              phase,
              description: synth.description,
              request_preview: {
                method: synth.method,
                upstream_url: synth.upstream_url,
                headers_template: synth.headers,
                secret_refs: referencedSecrets,
              },
              note: "Tool is live on the agent. ElevenLabs sees only the proxy URL + bearer; secrets are substituted at call time.",
            }),
          };
        }),
    ),
    tool(
      "delete_custom_tool",
      "Delete a tool that was synthesized via write_tool. Removes the ElevenLabs runtime tool, the backing custom_tools row (proxy secret + upstream spec), and detaches it from the agent. Use this — not remove_runtime_tool — when you know the tool came from write_tool. Pass the tool_id returned in the write_tool published response (or the id you see in the agent's tool list).",
      { tool_id: z.string().min(1) },
      async ({ tool_id }) =>
        runToolStep(ctx, "tools", "delete_custom_tool", async () => {
          const entry = ctx.config.tools.find((t) => t.id === tool_id);
          if (!entry) {
            throw new Error(`No tool with id "${tool_id}" on this agent.`);
          }
          const customTools = await customToolsCol();
          const row = await customTools.findOne({
            agent_id: new ObjectId(ctx.agentMongoId),
            elevenlabs_tool_id: tool_id,
          });
          const next = ctx.config.tools.filter((t) => t.id !== tool_id);
          if (!isLocalToolId(tool_id)) {
            await deleteRuntimeTool(tool_id).catch(() => {});
          }
          if (row) {
            await customTools.deleteOne({ _id: row._id }).catch(() => {});
          }
          return {
            patch: { tools: next },
            // Local-only ids never lived on ElevenLabs, so we skip the
            // upstream tool_ids update for lifecycle removals.
            upstreamPatch: { tool_ids: externalToolIds(next) },
            skipUpstream: isLocalToolId(tool_id),
            summary: `Deleted custom tool "${entry.name}".`,
          };
        }),
    ),
  ],
};

function prettify(slug: string): string {
  return slug
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
