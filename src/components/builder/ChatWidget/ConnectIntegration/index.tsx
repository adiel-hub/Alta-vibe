"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore, type WidgetEntry } from "@/store/agentStore";
import { attachToTurn } from "@/store/sseClient";
import { StatusBadge } from "../_shared/StatusBadge";
import { resolveWidget } from "../_shared/resolveWidget";
import { ExternalLinkIcon, EyeIcon, EyeOffIcon } from "../_shared/icons";
import { prettify } from "../_shared/prettify";
import { ProviderIcon } from "./ProviderIcon";
import { PROVIDER_DOCS } from "./providerDocs";

export function ConnectIntegrationWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as { provider: string; reason: string };
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // Workspace connection state, loaded from the provider-tools catalog on
  // mount. `null` = not yet loaded; bool = known. Determines whether the
  // user sees the Connect flow or the "already connected → Disconnect"
  // view.
  const [connected, setConnected] = useState<boolean | null>(null);
  const docs = PROVIDER_DOCS[payload.provider];
  const supportsToken = Boolean(docs?.tokenLabel);
  const supportsOAuth = Boolean(docs?.oauth);
  const popupRef = useRef<Window | null>(null);

  // Probe the workspace connection state once per mount. Re-runs only if
  // the agentId or provider changes (e.g. widget swap), not on local UI
  // state changes. The catalog endpoint is the same one the Tools tab
  // uses, so it's already warm in most sessions.
  useEffect(() => {
    let cancelled = false;
    appFetch(`/api/agents/${agentId}/provider-tools`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data: { catalog: Array<{ id: string; connected: boolean }> }) => {
        if (cancelled) return;
        const row = data.catalog.find((p) => p.id === payload.provider);
        setConnected(!!row?.connected);
      })
      .catch(() => {
        // Couldn't determine — fall through to the connect flow rather
        // than blocking the user. Disconnect is a no-op anyway if the
        // workspace isn't connected.
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, payload.provider]);

  // OAuth popup handshake. The /oauth/callback page postMessages back with
  // { type: 'google_calendar_oauth_success', action_id, resumed_job_id, … }
  // when the server-side finalisation is complete. We update local widget
  // state and attach to the resumed turn, mirroring what resolveWidget()
  // does in the paste-a-token flow.
  useEffect(() => {
    if (!supportsOAuth) return;
    function onMessage(ev: MessageEvent) {
      const data = ev.data as
        | {
            type?: string;
            action_id?: string;
            resumed_job_id?: string;
          }
        | null;
      if (!data || typeof data.type !== "string") return;
      if (!data.type.startsWith("google_calendar_oauth_")) return;
      if (data.action_id && data.action_id !== widget.action_id) return;
      setBusy(false);
      try {
        popupRef.current?.close();
      } catch {
        // popup may already be closed
      }
      if (data.type.endsWith("_success")) {
        useAgentStore
          .getState()
          .resolveWidget(widget.action_id, "done", { connected: true });
        if (data.resumed_job_id) {
          void attachToTurn(agentId, data.resumed_job_id, 0);
        }
      } else {
        setError("Google didn't finish the sign-in. Try again.");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [supportsOAuth, widget.action_id, agentId]);

  const startOAuth = async () => {
    if (!docs?.oauth) return;
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch(docs.oauth.startPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          action_id: widget.action_id,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        url?: string;
        error?: string;
      } | null;
      if (!res.ok || !json?.url) {
        throw new Error(json?.error ?? `Start failed (${res.status})`);
      }
      const popup = window.open(
        json.url,
        "google_calendar_oauth",
        "popup=yes,width=520,height=640",
      );
      if (!popup) {
        throw new Error(
          "Popup blocked. Allow popups for this site and try again.",
        );
      }
      popupRef.current = popup;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
      setBusy(false);
    }
  };

  const onConnect = async () => {
    setError(null);
    if (supportsOAuth) {
      await startOAuth();
      return;
    }
    // No-token providers (stub) resolve straight away; token providers
    // expand inline so the user can paste their PAT.
    if (!supportsToken) {
      setBusy(true);
      try {
        await resolveWidget(agentId, widget, "done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!expanded) {
      setExpanded(true);
      return;
    }
    const trimmed = token.trim();
    if (trimmed.length < 20) {
      setError("That doesn't look like a valid token. Paste the full value.");
      return;
    }
    setBusy(true);
    try {
      await resolveWidget(agentId, widget, "done", { token: trimmed });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const onDismiss = async () => {
    if (expanded) {
      setExpanded(false);
      setToken("");
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolveWidget(agentId, widget, "cancelled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  // Tear down the workspace integration. Flips the workspace `integrations`
  // row to disconnected, strips this agent's provider tools, and clears
  // the CRM caller-context block when applicable. After success we patch
  // the local store with the new tools/system_prompt so the right-panel
  // chips refresh immediately, and flip the widget into the
  // not-connected state so the user can either reconnect or dismiss.
  const onDisconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/integrations/${payload.provider}/disconnect`,
        { method: "POST" },
      );
      const json = (await res.json().catch(() => null)) as
        | {
            revision?: number;
            tools?: unknown;
            system_prompt?: string;
            error?: string;
          }
        | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `Disconnect failed (${res.status})`);
      }
      // Mirror the server-side patch into the agent store. The agent
      // store's `applyConfigDirect` expects a Partial<AgentConfigCache>;
      // we only ever get `tools` (+ `system_prompt` for CRMs) back.
      if (typeof json?.revision === "number") {
        const patch: Record<string, unknown> = {};
        if (Array.isArray(json.tools)) patch.tools = json.tools;
        if (typeof json.system_prompt === "string")
          patch.system_prompt = json.system_prompt;
        if (Object.keys(patch).length > 0) {
          applyConfigDirect(
            patch as Parameters<typeof applyConfigDirect>[0],
            json.revision,
          );
        }
      }
      setConnected(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  };

  const isPending = widget.status === "pending";
  const providerName = prettify(payload.provider);
  const connectLabel = busy
    ? supportsOAuth
      ? "Waiting for Google…"
      : "Connecting…"
    : "Connect";
  // Show the "already connected" view only while the widget is still
  // pending AND we've confirmed connection. The connect/disconnect UI is
  // suppressed once the widget itself resolves (done/cancelled/failed).
  const showConnectedView = isPending && connected === true;

  return (
    <div className="animate-scale-in overflow-hidden rounded-xl border border-(--color-border) bg-(--color-panel-soft) shadow-sm">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md bg-(--color-panel)">
            <ProviderIcon provider={payload.provider} />
          </span>
          <span className="truncate text-[13px] font-medium text-(--color-foreground-strong)">
            Connect Your {providerName} Account
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {widget.status !== "pending" && <StatusBadge status={widget.status} />}
          {docs && (
            <a
              href={docs.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${providerName} docs`}
              className="grid h-6 w-6 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel) hover:text-(--color-foreground-strong)"
            >
              <ExternalLinkIcon />
            </a>
          )}
        </div>
      </div>

      {isPending && !showConnectedView && expanded && supportsToken && docs?.tokenLabel && (
        <div className="border-t border-(--color-border) bg-(--color-panel) px-3 py-2.5">
          <label className="mb-1 block text-[11px] font-medium text-(--color-muted)">
            Paste your {docs.tokenLabel}
          </label>
          <div className="relative">
            <input
              type={revealed ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder="pat-na1-..."
              className="w-full rounded-md border border-(--color-border) bg-white px-2.5 py-1.5 pr-9 font-mono text-[11px] outline-none focus:border-(--color-accent)"
            />
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              aria-label={revealed ? "Hide token" : "Show token"}
              title={revealed ? "Hide token" : "Show token"}
              className="absolute right-1 top-1/2 grid h-6 w-7 -translate-y-1/2 place-items-center rounded text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>
      )}

      {showConnectedView && (
        <div className="flex items-center gap-2 border-t border-(--color-border) bg-(--color-panel) px-3 py-2 text-[12px]">
          <span
            className="inline-block h-2 w-2 flex-shrink-0 rounded-full bg-emerald-500"
            aria-hidden
          />
          <span className="text-(--color-foreground-strong)">
            {providerName} is connected for this workspace.
          </span>
        </div>
      )}

      {isPending && showConnectedView && (
        <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="text-[12px] text-(--color-muted) transition hover:text-(--color-foreground-strong) disabled:opacity-50"
          >
            Dismiss
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDisconnect}
            className="rounded-md border border-(--color-danger)/40 px-3 py-1 text-[12px] font-medium text-(--color-danger) transition hover:bg-(--color-danger)/10 disabled:opacity-50"
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      )}

      {isPending && !showConnectedView && (
        <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="text-[12px] text-(--color-muted) transition hover:text-(--color-foreground-strong) disabled:opacity-50"
          >
            {expanded ? "Cancel" : "Dismiss"}
          </button>
          <Button
            size="sm"
            disabled={busy || (expanded && token.trim().length === 0)}
            onClick={onConnect}
          >
            {connectLabel}
          </Button>
        </div>
      )}

      {(error || payload.reason) && isPending && !expanded && !showConnectedView && (
        <p className="border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5 text-[11px] text-(--color-muted)">
          {error ? (
            <span className="text-(--color-danger)">{error}</span>
          ) : (
            payload.reason
          )}
        </p>
      )}
      {error && showConnectedView && (
        <p className="border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5 text-[11px] text-(--color-danger)">
          {error}
        </p>
      )}
      {error && expanded && !showConnectedView && (
        <p className="border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5 text-[11px] text-(--color-danger)">
          {error}
        </p>
      )}
    </div>
  );
}
