/**
 * Outbound pre-call enrichment. Runs BEFORE we ask ElevenLabs to dial so
 * the `dynamic_variables` we hand to the outbound API already carry CRM +
 * internal context — the agent's first TTS chunk can reference
 * {{caller_first_name}}, {{account_industry}}, {{engagement_summary}}, etc.
 *
 * Execution model — WAVES:
 *
 *   1. Build a typed `CallerContext` from input (to_number, caller_email,
 *      prospect_id, …). Seed `merged` with its scalars + custom_fields.
 *   2. Loop: find tools whose `needs` are all keys in `merged` and haven't
 *      run yet. Run them in parallel via `Promise.allSettled`, each with
 *      its own `timeout_ms`. Merge outputs (priority-aware) into `merged`.
 *      Continue until no new tools are ready.
 *   3. Tools left pending (unsatisfied needs) are logged + skipped.
 *   4. Compose `caller_context_summary` from per-tool narratives.
 *   5. Persist an audit doc to `pre_call_executions` so future debugging
 *      doesn't require log archaeology.
 *
 * A tool with `abort_on_failure: true` that fails (timeout, error, non-2xx)
 * throws `PreCallAbortError`. Callers (outbound-call route, campaign
 * runner) catch it and skip the dial.
 */
import { ObjectId } from "mongodb";
import { agentsCol, customToolsCol, preCallExecutionsCol } from "@/lib/mongodb";
import { runPreCallTool, type DispatchResult } from "@/lib/elevenlabs/lifecycle/dispatch";
import { findSpecForInstalledTool } from "./providers";
import { buildCallerContext, type CallerContext } from "@/lib/calls/callerContext";
import { PreCallAbortError } from "@/lib/calls/preCallAbortError";
import type { RuntimeTool } from "@/types/agent";
import type { ProviderRuntimeToolSpec } from "./providers/types";
import { createLogger } from "@/lib/logger";

const log = createLogger("enrichment");

function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}

/**
 * Resolve a `RuntimeTool` to its `ProviderRuntimeToolSpec`. First tries
 * the static provider registry; if not found, checks for a custom-tool
 * URL pattern and synthesizes an in-memory spec from `custom_tools`. The
 * virtual spec uses `build_body` to forward the full merged context as a
 * flat JSON body — upstream APIs pick the fields they care about.
 */
async function resolveSpecForRuntimeTool(
  tool: RuntimeTool,
): Promise<ProviderRuntimeToolSpec | undefined> {
  // 1) Static provider registry (alta, hubspot, slack, google_calendar, ...).
  const fromRegistry = findSpecForInstalledTool(tool);
  if (fromRegistry) return fromRegistry;

  // 2) Custom tool — URL shape /api/custom-tools/proxy/<agentId>/<customToolId>.
  if (!tool.url) return undefined;
  const m = tool.url.match(/\/api\/custom-tools\/proxy\/[^/]+\/([a-f0-9]{24})/i);
  if (!m) return undefined;
  const customToolId = m[1];
  const doc = await (await customToolsCol()).findOne({
    _id: new ObjectId(customToolId),
  });
  if (!doc) return undefined;

  return {
    key: doc.name,
    name: doc.name,
    description: doc.description,
    phase: doc.phase,
    method: doc.upstream.method,
    path: doc.upstream.url,
    body_schema: doc.upstream.body_schema as Record<string, unknown> | undefined,
    query_schema: doc.upstream.query_schema as Record<string, unknown> | undefined,
    needs: doc.needs,
    // Pre-call custom tools: forward the entire merged context as the body.
    // Upstream APIs ignore unknown fields; this gives the user the maximum
    // amount of input without forcing them to declare every field.
    build_body: doc.phase === "pre_call"
      ? (ctx, prior) => ({ ...prior, ...flattenCtxForBody(ctx) })
      : undefined,
  };
}

function flattenCtxForBody(ctx: CallerContext): Record<string, string> {
  const out: Record<string, string> = {
    to_number: ctx.to_number,
    caller_email: ctx.caller_email,
    prospect_id: ctx.prospect_id,
    full_name: ctx.full_name,
    first_name: ctx.first_name,
    last_name: ctx.last_name,
    job_title: ctx.job_title,
    job_company_name: ctx.job_company_name,
    linkedin_url: ctx.linkedin_url,
    audience_id: ctx.audience_id,
    campaign_id: ctx.campaign_id,
  };
  for (const [k, v] of Object.entries(ctx.custom_fields)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Walk dot-paths like "results.0.properties.firstname". */
function getByPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  let cursor: unknown = obj;
  for (const seg of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cursor = cursor[idx];
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/** Surface CallerContext scalars + custom_fields directly. */
function pushScalars(
  merged: Record<string, string>,
  ctx: CallerContext,
): void {
  const flat: Record<string, string> = {
    to_number: ctx.to_number,
    caller_email: ctx.caller_email,
    prospect_id: ctx.prospect_id,
    full_name: ctx.full_name,
    first_name: ctx.first_name,
    last_name: ctx.last_name,
    job_title: ctx.job_title,
    job_company_name: ctx.job_company_name,
    linkedin_url: ctx.linkedin_url,
    audience_id: ctx.audience_id,
    campaign_id: ctx.campaign_id,
  };
  for (const [k, v] of Object.entries(flat)) {
    if (v) merged[k] = v;
  }
  for (const [k, v] of Object.entries(ctx.custom_fields)) {
    if (typeof v === "string" && v) merged[k] = v;
  }
}

/** Project a tool's output into the merged variable map. */
function projectOutput(
  merged: Record<string, string>,
  priorityMap: Record<string, number>,
  spec: ProviderRuntimeToolSpec,
  output: unknown,
  onCollision: (varName: string, byTool: string) => void,
): void {
  const toolPriority = spec.priority ?? 0;
  const setVar = (k: string, v: string) => {
    const existing = priorityMap[k];
    if (existing !== undefined && toolPriority < existing) {
      onCollision(k, spec.name);
      return;
    }
    merged[k] = v;
    priorityMap[k] = toolPriority;
  };

  if (spec.output_aliases) {
    for (const [varName, jsonPath] of Object.entries(spec.output_aliases)) {
      const v = getByPath(output, jsonPath);
      if (isScalar(v)) {
        const s = String(v);
        if (s !== "") setVar(varName, s);
      }
    }
  } else if (output && typeof output === "object") {
    const bare = spec.name.replace(/^pre_call__/, "");
    for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
      if (isScalar(v)) {
        const s = String(v);
        if (s !== "") setVar(`pre_${bare}__${k}`, s);
      }
    }
  }
}

export type EnrichmentResult = {
  /** dynamic_variables to hand ElevenLabs. */
  variables: Record<string, string>;
  /** Tools that ran successfully. */
  executed: string[];
  /** Tools that were skipped (needs unsatisfied, failed, returned null). */
  skipped: Array<{ tool: string; reason: string }>;
  duration_ms: number;
};

export async function enrichCallContext(input: {
  agentMongoId: string;
  to_number: string;
  caller_email?: string;
  prospect_id?: string;
  audience_id?: string;
  campaign_id?: string;
}): Promise<Record<string, string>> {
  const result = await enrichCallContextDetailed(input);
  return result.variables;
}

/**
 * Same as `enrichCallContext` but returns the full audit object. Used by
 * routes that want to surface execution metadata; the simple
 * `enrichCallContext` wraps this and discards the audit.
 */
export async function enrichCallContextDetailed(input: {
  agentMongoId: string;
  to_number: string;
  caller_email?: string;
  prospect_id?: string;
  audience_id?: string;
  campaign_id?: string;
}): Promise<EnrichmentResult> {
  const startedAt = new Date();

  if (!ObjectId.isValid(input.agentMongoId)) {
    return emptyResult(startedAt, "invalid agent id");
  }
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(input.agentMongoId) });
  if (!agent) return emptyResult(startedAt, "agent not found");

  const ctx = await buildCallerContext({
    to_number: input.to_number,
    caller_email: input.caller_email,
    prospect_id: input.prospect_id,
    audience_id: input.audience_id,
    campaign_id: input.campaign_id,
  });

  const merged: Record<string, string> = {};
  const priorityMap: Record<string, number> = {};
  pushScalars(merged, ctx);

  // Snapshot installed pre-call tools + resolve specs upfront. Spec lookup
  // can hit the DB for custom tools — pre-resolving avoids repeated lookups
  // across wave iterations.
  const allTools = agent.config_cache.tools.filter(
    (t) => t.phase === "pre_call",
  );
  const specByName = new Map<string, ProviderRuntimeToolSpec>();
  const pending = new Set<RuntimeTool>();
  const executed: string[] = [];
  const skipped: Array<{ tool: string; reason: string }> = [];
  const narratives: string[] = [];

  for (const tool of allTools) {
    const spec = await resolveSpecForRuntimeTool(tool);
    if (!spec) {
      skipped.push({ tool: tool.name, reason: "spec not found" });
      continue;
    }
    specByName.set(tool.name, spec);
    pending.add(tool);
  }

  // ── Wave loop ────────────────────────────────────────────────────────
  while (pending.size > 0) {
    const ready: Array<{ tool: RuntimeTool; spec: ProviderRuntimeToolSpec }> = [];
    for (const tool of pending) {
      const spec = specByName.get(tool.name)!;
      const needs = spec.needs ?? [];
      if (needs.every((k) => k in merged)) {
        ready.push({ tool, spec });
      }
    }

    if (ready.length === 0) {
      for (const tool of pending) {
        skipped.push({ tool: tool.name, reason: "needs not satisfied" });
      }
      break;
    }

    // Run wave in parallel.
    const results = await Promise.allSettled(
      ready.map(({ tool, spec }) => runPreCallTool(tool, spec, ctx, merged)),
    );

    for (let i = 0; i < ready.length; i++) {
      const { tool, spec } = ready[i];
      pending.delete(tool);
      const r = results[i];

      // Handle settled outcomes.
      let dispatch: DispatchResult;
      if (r.status === "rejected") {
        dispatch = {
          tool_name: tool.name,
          ok: false,
          status: 0,
          output: null,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
      } else {
        dispatch = r.value;
      }

      if (!dispatch.ok) {
        if (spec.abort_on_failure) {
          throw new PreCallAbortError(tool.name, dispatch.error ?? "failed");
        }
        skipped.push({ tool: tool.name, reason: dispatch.error ?? "failed" });
        continue;
      }

      // Null output = "no data" (not an error). Skip projection but count
      // as executed.
      if (dispatch.output === null) {
        executed.push(tool.name);
        continue;
      }

      projectOutput(
        merged,
        priorityMap,
        spec,
        dispatch.output,
        (varName, byTool) =>
          log.warn("variable collision", {
            var: varName,
            tool_loser: byTool,
            existing_priority: priorityMap[varName],
            attempted_priority: spec.priority ?? 0,
          }),
      );

      const n = spec.narrative?.(ctx, dispatch.output);
      if (n) narratives.push(n);

      executed.push(tool.name);
    }
  }

  // Derived: caller_name from first + last.
  if (
    !merged.caller_name &&
    (merged.caller_first_name || merged.caller_last_name)
  ) {
    merged.caller_name = [merged.caller_first_name, merged.caller_last_name]
      .filter(Boolean)
      .join(" ");
  }

  // Narrative summary.
  if (narratives.length > 0) {
    merged.caller_context_summary = narratives.map((n) => `- ${n}`).join("\n");
  }

  const endedAt = new Date();
  const duration_ms = endedAt.getTime() - startedAt.getTime();

  // Audit log — fire-and-forget; never block the call on logging.
  void writeAuditLog({
    agent_id: agent._id,
    campaign_id: input.campaign_id ?? null,
    prospect_id: input.prospect_id ?? null,
    to_number: input.to_number,
    status: "ok",
    abort_reason: null,
    executed,
    skipped,
    variables_count: Object.keys(merged).length,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms,
  });

  return {
    variables: merged,
    executed,
    skipped,
    duration_ms,
  };
}

function emptyResult(startedAt: Date, reason: string): EnrichmentResult {
  log.warn("enrichment short-circuit", { reason });
  return {
    variables: {},
    executed: [],
    skipped: [],
    duration_ms: Date.now() - startedAt.getTime(),
  };
}

async function writeAuditLog(input: {
  agent_id: ObjectId;
  campaign_id: string | null;
  prospect_id: string | null;
  to_number: string;
  status: "ok" | "aborted";
  abort_reason: string | null;
  executed: string[];
  skipped: Array<{ tool: string; reason: string }>;
  variables_count: number;
  started_at: Date;
  ended_at: Date;
  duration_ms: number;
}): Promise<void> {
  try {
    const col = await preCallExecutionsCol();
    await col.insertOne({
      _id: new ObjectId(),
      agent_id: input.agent_id,
      campaign_id:
        input.campaign_id && ObjectId.isValid(input.campaign_id)
          ? new ObjectId(input.campaign_id)
          : null,
      prospect_id:
        input.prospect_id && ObjectId.isValid(input.prospect_id)
          ? new ObjectId(input.prospect_id)
          : null,
      to_number: input.to_number,
      conversation_id: null,
      status: input.status,
      abort_reason: input.abort_reason,
      executed: input.executed,
      skipped: input.skipped,
      variables_count: input.variables_count,
      duration_ms: input.duration_ms,
      started_at: input.started_at,
      ended_at: input.ended_at,
    });
  } catch (err) {
    log.warn("audit log insert failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Export the helper so callers (outbound-call route, campaign runner) can
 * record the abort in the audit log when they catch PreCallAbortError.
 */
export async function recordAbortAudit(input: {
  agent_id: ObjectId;
  campaign_id: string | null;
  prospect_id: string | null;
  to_number: string;
  tool_name: string;
  reason: string;
  started_at: Date;
}): Promise<void> {
  const endedAt = new Date();
  await writeAuditLog({
    agent_id: input.agent_id,
    campaign_id: input.campaign_id,
    prospect_id: input.prospect_id,
    to_number: input.to_number,
    status: "aborted",
    abort_reason: `${input.tool_name}: ${input.reason}`,
    executed: [],
    skipped: [{ tool: input.tool_name, reason: input.reason }],
    variables_count: 0,
    started_at: input.started_at,
    ended_at: endedAt,
    duration_ms: endedAt.getTime() - input.started_at.getTime(),
  });
}
