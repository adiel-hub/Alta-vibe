"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { WidgetEntry } from "@/store/agentStore";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const docs = PROVIDER_DOCS[payload.provider];
  const supportsToken = Boolean(docs);

  const onConnect = async () => {
    setError(null);
    // No-token providers (OAuth) resolve straight away; token providers
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

  const isPending = widget.status === "pending";
  const providerName = prettify(payload.provider);

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

      {isPending && expanded && supportsToken && (
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

      {isPending && (
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
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      )}

      {(error || payload.reason) && isPending && !expanded && (
        <p className="border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5 text-[11px] text-(--color-muted)">
          {error ? (
            <span className="text-(--color-danger)">{error}</span>
          ) : (
            payload.reason
          )}
        </p>
      )}
      {error && expanded && (
        <p className="border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5 text-[11px] text-(--color-danger)">
          {error}
        </p>
      )}
    </div>
  );
}
