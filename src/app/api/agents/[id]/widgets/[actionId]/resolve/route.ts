/**
 * Widget resolution endpoint. Browser POSTs here when the user completes an
 * interactive widget (connects an integration, confirms, picks an option).
 *
 * On success:
 *   - Mark widget_actions row done
 *   - If kind=connect_integration: run the side-effect (register provider's
 *     runtime tools on the agent) using the stub credentials
 *   - Insert a synthetic SYSTEM chat message describing the resolution
 *   - Enqueue a new turn so the agent's loop continues with the result
 *     in its transcript.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { after } from "next/server";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, widgetActionsCol } from "@/lib/mongodb";
import { enqueueTurnJob, processTurnJob } from "@/lib/turn-jobs/runner";
import { registerProviderForAgent } from "@/lib/integrations/registerProviderTools";
import { encryptToken } from "@/lib/integrations/tokens";
import { addProspectsToAudience } from "@/lib/audiences/addProspects";
import type { PdlProspect } from "@/lib/pdl/client";
import { validateToken as validateHubspotToken } from "@/lib/integrations/hubspot/auth";
import { storeAgentSecret } from "@/lib/integrations/agentSecrets";
import {
  assignPhoneNumberToAgent,
  importSIPTrunkPhoneNumber,
  importTwilioPhoneNumber,
  type InboundSIPTrunkConfig,
  type OutboundSIPTrunkConfig,
} from "@/lib/elevenlabs/client";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  status: z.enum(["done", "cancelled", "failed"]).default("done"),
  result: z.unknown().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const log = createLogger("widget", {
    route: "POST /widgets/[actionId]/resolve",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, actionId } = await params;
  log.info("resolve", { agent_id: id, action_id: actionId });
  if (!ObjectId.isValid(id) || !ObjectId.isValid(actionId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const agentId = new ObjectId(id);
  const _actionId = new ObjectId(actionId);

  const parsed = Body.safeParse(await req.json().catch(() => ({ status: "done" })));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const agent = await (await agentsCol()).findOne({ _id: agentId });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const widgets = await widgetActionsCol();
  const action = await widgets.findOne({ _id: _actionId, agent_id: agentId });
  if (!action) return NextResponse.json({ error: "Action not found" }, { status: 404 });
  if (action.status !== "pending") {
    return NextResponse.json({ error: "Action already resolved" }, { status: 409 });
  }

  let summary = "User cancelled the action.";
  let effectMessage: string | null = null;
  // Side-effect-driven config delta for the client store. Set by side-
  // effect branches (e.g. connect_integration) when they mutate
  // config_cache directly outside the chat turn lifecycle — the resumed
  // turn won't emit a state_patch for these, so we return it inline.
  let configPatch: { revision: number; patch: Record<string, unknown> } | null = null;
  if (parsed.data.status === "done") {
    if (action.kind === "connect_integration") {
      const provider = (action.payload as { provider?: string }).provider;
      if (provider) {
        log.info("integration connect", { provider });
        const credsResult = await buildCredentialsForProvider(
          provider,
          parsed.data.result,
        );
        if (!credsResult.ok) {
          log.warn("integration creds rejected", {
            provider,
            reason: credsResult.error,
          });
          await widgets.updateOne(
            { _id: _actionId },
            {
              $set: {
                status: "failed",
                result: { error: credsResult.error },
                resolved_at: new Date(),
              },
            },
          );
          const rejectedMessage = `User attempted to connect ${provider} but the token was rejected: ${credsResult.error} In one short message, tell the user what likely went wrong (wrong token type, missing scopes, or a typo) and the simplest next step. Do NOT re-open the connect widget automatically — wait for the user to confirm they want to retry before calling request_user_action again.`;
          const rejectedJobId = await enqueueTurnJob(
            agentId,
            rejectedMessage,
            "system",
          );
          if (!process.env.USE_RAILWAY_WORKER) {
            after(async () => {
              try {
                await processTurnJob(rejectedJobId);
              } catch {
                // job runner handles its own failures
              }
            });
          }
          return NextResponse.json({
            status: "failed",
            error: credsResult.error,
            resumed_job_id: rejectedJobId.toHexString(),
          });
        }
        try {
          const { added_tools } = await registerProviderForAgent(
            id,
            provider,
            credsResult.credentials,
          );
          log.info("integration registered", { provider, added_tools });
          summary = `Connected ${provider}.`;
          effectMessage = `User connected ${provider}. ${added_tools} runtime tool${added_tools === 1 ? "" : "s"} are now available on the agent, and pre-call enrichment is active. Ask the user — in one short message — whether they want to wire ${provider} into the workflow now (e.g., add tool_call nodes that look up / create / update records at the right step). If they say yes, propose a concrete spot in the current workflow and use edit_workflow to add the node(s); if they say no or "later", acknowledge briefly and move on. Do NOT modify the workflow before they answer.`;
          // Surface the cascade's effects to the client. The cascade
          // patched config_cache.tools (and possibly system_prompt) on
          // the agent doc directly, before the resumed turn fires —
          // which means the SSE stream won't carry a state_patch for
          // these mutations and the workflow/tools panels would
          // otherwise keep showing pre-cascade state until reload.
          const agentsLocal = await agentsCol();
          const fresh = await agentsLocal.findOne({ _id: new ObjectId(id) });
          if (fresh) {
            configPatch = {
              revision: fresh.revision,
              patch: {
                tools: fresh.config_cache.tools,
                system_prompt: fresh.config_cache.system_prompt,
              },
            };
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "register failed";
          log.error("integration register failed", { provider, message });
          summary = `Failed to connect ${provider}: ${message}`;
          effectMessage = `User attempted to connect ${provider} but registration failed: ${message}`;
        }
      }
    } else if (action.kind === "confirm") {
      summary = "User confirmed.";
      effectMessage = "User confirmed the requested action.";
    } else if (action.kind === "pick_option") {
      const choice = (parsed.data.result as { value?: string } | undefined)?.value;
      summary = `User picked: ${choice ?? "(unknown)"}.`;
      effectMessage = `User picked option: ${choice ?? "(unknown)"}.`;
    } else if (action.kind === "phone_number_setup") {
      const raw = (parsed.data.result ?? {}) as Record<string, unknown>;
      const provider = raw.provider;
      const phoneNumber =
        typeof raw.phone_number === "string" ? raw.phone_number.trim() : "";
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      const attachAfter =
        (action.payload as { attach_after_import?: boolean }).attach_after_import !==
        false;
      if (!phoneNumber || !label) {
        log.warn("phone_number_setup rejected: missing phone_number or label");
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: "Missing phone_number or label" },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({
          status: "failed",
          error: "Missing phone_number or label",
        });
      }
      try {
        let imported: { phone_number_id: string };
        if (provider === "twilio") {
          const sid = typeof raw.sid === "string" ? raw.sid.trim() : "";
          const token = typeof raw.token === "string" ? raw.token.trim() : "";
          if (!sid || !token) {
            throw new Error("Twilio import requires sid and token");
          }
          imported = await importTwilioPhoneNumber({
            phone_number: phoneNumber,
            label,
            sid,
            token,
          });
        } else if (provider === "sip_trunk") {
          const outbound =
            (raw.outbound_trunk_config as OutboundSIPTrunkConfig | undefined) ??
            undefined;
          const inbound =
            (raw.inbound_trunk_config as InboundSIPTrunkConfig | undefined) ??
            undefined;
          imported = await importSIPTrunkPhoneNumber({
            phone_number: phoneNumber,
            label,
            inbound_trunk_config: inbound ?? null,
            outbound_trunk_config: outbound ?? null,
          });
        } else {
          throw new Error(
            `Unknown phone provider '${String(provider)}'. Expected 'twilio' or 'sip_trunk'.`,
          );
        }
        log.info("phone imported", {
          provider,
          phone_number_id: imported.phone_number_id,
          attach_after: attachAfter,
        });
        if (attachAfter) {
          await assignPhoneNumberToAgent(
            imported.phone_number_id,
            agent.elevenlabs_agent_id,
          );
        }
        summary = `Imported ${label} (${phoneNumber}).`;
        effectMessage = `User imported a ${String(provider)} phone number "${label}" (${phoneNumber}) with id ${imported.phone_number_id}.${
          attachAfter
            ? " It is now attached to this agent."
            : " It was NOT attached — call assign_phone_number_to_agent next if the user wants the agent to use it."
        }`;
      } catch (err) {
        const message = err instanceof Error ? err.message : "import failed";
        log.error("phone import failed", { provider, message });
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: message },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({ status: "failed", error: message });
      }
    } else if (action.kind === "audience_source_picker") {
      const source = (parsed.data.result as { source?: string } | undefined)
        ?.source;
      if (source === "pdl") {
        summary = "User picked: PDL search.";
        effectMessage =
          "User picked PDL for audience source. In ONE short message, ask what kind of prospects they want (industry, role, location). Wait for their answer, then call pdl_search_and_present_prospects. Do NOT search until they answer.";
      } else if (source === "hubspot") {
        summary = "User picked: HubSpot CRM.";
        effectMessage =
          "User picked HubSpot for audience source. Call present_hubspot_contacts_picker now. If it returns an error because HubSpot isn't connected, then call request_user_action(kind='connect_integration', { provider: 'hubspot', reason: 'so we can sync contacts into your audience' }) — and ONLY after they finish connecting, retry present_hubspot_contacts_picker.";
      } else if (source === "csv") {
        summary = "User picked: CSV upload.";
        effectMessage =
          "User picked CSV for audience source. Call present_csv_upload_widget now. Your turn will end as soon as the widget appears; the user fills it in and the platform resumes you with the outcome.";
      } else {
        log.warn("audience_source_picker rejected: unknown source", { source });
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: "Unknown source" },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({
          status: "failed",
          error: "Unknown source",
        });
      }
    } else if (action.kind === "csv_upload") {
      // Same shape as select_prospects — the widget already produced the
      // prospect rows client-side via applyMapping() over the user's column
      // mapping. Reuse addProspectsToAudience so dedup / audience upsert is
      // identical across sources.
      const result = (parsed.data.result ?? {}) as {
        prospects?: unknown;
        audience?: unknown;
      };
      const prospectsFromWidget = Array.isArray(result.prospects)
        ? (result.prospects as PdlProspect[])
        : [];
      const audienceTarget = result.audience as
        | { id?: string; new_name?: string }
        | undefined;
      const target =
        audienceTarget && typeof audienceTarget.id === "string"
          ? { id: audienceTarget.id }
          : audienceTarget && typeof audienceTarget.new_name === "string"
            ? { new_name: audienceTarget.new_name }
            : null;
      if (!target || prospectsFromWidget.length === 0) {
        log.warn("csv_upload rejected: missing target or prospects");
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: "Missing audience or prospects" },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({
          status: "failed",
          error: "Missing audience or prospects",
        });
      }
      try {
        const outcome = await addProspectsToAudience({
          target,
          prospects: prospectsFromWidget,
        });
        log.info("csv prospects added", {
          audience: outcome.audience.name,
          added: outcome.added,
          skipped: outcome.skipped,
        });
        summary = `Imported ${outcome.added} prospect${
          outcome.added === 1 ? "" : "s"
        } into "${outcome.audience.name}".`;
        const skippedNote =
          outcome.skipped > 0
            ? ` ${outcome.skipped} were already in the audience and were skipped.`
            : "";
        effectMessage = `User imported ${outcome.added} CSV prospect${
          outcome.added === 1 ? "" : "s"
        } into the "${outcome.audience.name}" audience. The audience now contains ${outcome.total_in_audience} prospect${
          outcome.total_in_audience === 1 ? "" : "s"
        }.${skippedNote} In ONE short message: confirm the count, name the audience, and remind them they can run a campaign from the Audiences page.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : "import failed";
        log.error("csv_upload failed", { message });
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: message },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({ status: "failed", error: message });
      }
    } else if (action.kind === "select_prospects") {
      const result = (parsed.data.result ?? {}) as {
        selected_prospect_ids?: unknown;
        prospects?: unknown;
        audience?: unknown;
      };
      const selectedIds = Array.isArray(result.selected_prospect_ids)
        ? (result.selected_prospect_ids.filter((s) => typeof s === "string") as string[])
        : [];
      const prospectsFromWidget = Array.isArray(result.prospects)
        ? (result.prospects as PdlProspect[])
        : [];
      // The widget posts back the prospects it already has on hand, so we
      // don't need to look them up again. Filter to the selected ids just
      // in case the widget UI ever drifts.
      const selectedSet = new Set(selectedIds);
      const chosen = prospectsFromWidget.filter((p) =>
        selectedSet.has(p.pdl_id),
      );
      const audienceTarget = result.audience as
        | { id?: string; new_name?: string }
        | undefined;
      const target =
        audienceTarget && typeof audienceTarget.id === "string"
          ? { id: audienceTarget.id }
          : audienceTarget && typeof audienceTarget.new_name === "string"
            ? { new_name: audienceTarget.new_name }
            : null;
      if (!target || chosen.length === 0) {
        log.warn("select_prospects rejected: missing target or prospects");
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: "Missing audience or selected prospects" },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({
          status: "failed",
          error: "Missing audience or selected prospects",
        });
      }
      try {
        const outcome = await addProspectsToAudience({
          target,
          prospects: chosen,
        });
        log.info("prospects added to audience", {
          audience: outcome.audience.name,
          added: outcome.added,
          skipped: outcome.skipped,
          total: outcome.total_in_audience,
        });
        summary = `Added ${outcome.added} prospect${
          outcome.added === 1 ? "" : "s"
        } to "${outcome.audience.name}".`;
        const skippedNote =
          outcome.skipped > 0
            ? ` ${outcome.skipped} were already in the audience and were skipped.`
            : "";
        effectMessage = `User added ${outcome.added} prospect${
          outcome.added === 1 ? "" : "s"
        } from the PDL search to the "${outcome.audience.name}" audience. The audience now contains ${outcome.total_in_audience} prospect${
          outcome.total_in_audience === 1 ? "" : "s"
        }.${skippedNote} Tell the user in ONE short message: confirm the count, name the audience, and remind them they can start a call campaign from the Audiences page (link in the masthead) when they're ready. Do NOT propose another PDL search unless they ask.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : "add failed";
        log.error("select_prospects failed", { message });
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: message },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({ status: "failed", error: message });
      }
    } else if (action.kind === "collect_secret") {
      type SecretEntry = { name?: string; description?: string };
      const payload = action.payload as
        | SecretEntry
        | { secrets?: SecretEntry[] };
      const entries: SecretEntry[] = Array.isArray(
        (payload as { secrets?: SecretEntry[] }).secrets,
      )
        ? ((payload as { secrets: SecretEntry[] }).secrets)
        : [payload as SecretEntry];
      const rawResult = (parsed.data.result ?? {}) as {
        value?: unknown;
        values?: unknown;
      };
      // Normalise both shapes into a { [name]: value } map.
      const pairs: Array<{ name: string; description: string; value: string }> =
        [];
      if (entries.length === 1 && typeof rawResult.value === "string") {
        const entry = entries[0];
        if (typeof entry.name === "string" && rawResult.value.trim().length > 0) {
          pairs.push({
            name: entry.name,
            description: entry.description ?? "",
            value: rawResult.value,
          });
        }
      } else if (
        rawResult.values &&
        typeof rawResult.values === "object" &&
        !Array.isArray(rawResult.values)
      ) {
        const map = rawResult.values as Record<string, unknown>;
        for (const entry of entries) {
          if (typeof entry.name !== "string") continue;
          const v = map[entry.name];
          if (typeof v !== "string" || v.trim().length === 0) continue;
          pairs.push({
            name: entry.name,
            description: entry.description ?? "",
            value: v,
          });
        }
      }
      if (pairs.length === 0 || pairs.length !== entries.length) {
        log.warn("collect_secret rejected (missing name or value)");
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: "Missing secret name or value" },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({
          status: "failed",
          error: "Missing secret name or value",
        });
      }
      try {
        for (const p of pairs) {
          await storeAgentSecret(id, p.name, p.description, p.value);
        }
        const names = pairs.map((p) => p.name);
        log.info("secret stored", { names });
        summary =
          names.length === 1
            ? `Saved secret '${names[0]}'.`
            : `Saved secrets: ${names.map((n) => `'${n}'`).join(", ")}.`;
        const handlesLabel =
          names.length === 1
            ? `addressable as '${names[0]}'`
            : `addressable as ${names.map((n) => `'${n}'`).join(", ")}`;
        effectMessage = `User saved ${names.length === 1 ? "a secret" : `${names.length} secrets`}. ${names.length === 1 ? "It is" : "They are"} now stored encrypted and ${handlesLabel}. The value${names.length === 1 ? " is" : "s are"} NOT visible to you — when you generate runtime tool code that needs ${names.length === 1 ? "it" : "them"}, reference by name and the platform will inject at call time.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : "store failed";
        log.error("secret store failed", { message });
        await widgets.updateOne(
          { _id: _actionId },
          {
            $set: {
              status: "failed",
              result: { error: message },
              resolved_at: new Date(),
            },
          },
        );
        return NextResponse.json({ status: "failed", error: message });
      }
    }
  } else {
    effectMessage = `User cancelled the widget action.`;
  }

  // Redact the secret value before persisting the widget result row — the
  // ciphertext lives in agent_secrets; the raw plaintext must never linger
  // in widget_actions where it could be re-read by chat history loaders.
  const persistedResult =
    parsed.data.status === "done" && action.kind === "collect_secret"
      ? { saved: true }
      : parsed.data.result ?? null;

  await widgets.updateOne(
    { _id: _actionId },
    {
      $set: {
        status: parsed.data.status,
        result: persistedResult,
        resolved_at: new Date(),
      },
    },
  );

  if (effectMessage) {
    const newJobId = await enqueueTurnJob(agentId, effectMessage, "system");
    if (!process.env.USE_RAILWAY_WORKER) {
      after(async () => {
        try {
          await processTurnJob(newJobId);
        } catch {
          // job runner handles its own failures
        }
      });
    }
    return NextResponse.json({
      status: parsed.data.status,
      summary,
      resumed_job_id: newJobId.toHexString(),
      ...(configPatch ? { config_patch: configPatch } : {}),
    });
  }

  return NextResponse.json({
    status: parsed.data.status,
    summary,
    ...(configPatch ? { config_patch: configPatch } : {}),
  });
}

/**
 * Translate the raw widget-resolve `result` for a provider into the
 * encrypted credentials blob we persist. Returns a discriminated union
 * so the caller can surface validation failures back to the chat.
 */
type CredsResult =
  | { ok: true; credentials: Record<string, unknown> }
  | { ok: false; error: string };

async function buildCredentialsForProvider(
  provider: string,
  rawResult: unknown,
): Promise<CredsResult> {
  if (provider === "hubspot") {
    const token =
      rawResult && typeof rawResult === "object" && rawResult !== null
        ? (rawResult as { token?: unknown }).token
        : undefined;
    if (typeof token !== "string" || token.trim().length < 20) {
      return {
        ok: false,
        error: "No HubSpot token provided. Paste the full Private App token.",
      };
    }
    const accountInfo = await validateHubspotToken(token.trim());
    if (!accountInfo) {
      return {
        ok: false,
        error:
          "Token rejected by HubSpot. Double-check it's a Private App token with the required scopes.",
      };
    }
    return {
      ok: true,
      credentials: {
        access_token: encryptToken(token.trim()),
        connected_via: "pat",
        hub_id: accountInfo.portalId,
        ui_domain: accountInfo.uiDomain ?? null,
      },
    };
  }
  // Fallback for stub providers until they're wired with real OAuth or PAT flows.
  return {
    ok: true,
    credentials: { access_token: "stub_token_dev_only", connected_via: "stub" },
  };
}
