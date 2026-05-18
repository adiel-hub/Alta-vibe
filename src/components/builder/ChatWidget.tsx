"use client";

import { useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore, type WidgetEntry } from "@/store/agentStore";
import { attachToTurn } from "@/store/sseClient";
import { createClientLogger } from "@/lib/clientLogger";

const log = createClientLogger("widget");

export function ChatWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  if (widget.kind === "connect_integration") {
    return <ConnectIntegrationWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "confirm") {
    return <ConfirmWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "pick_option") {
    return <PickOptionWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "collect_secret") {
    return <CollectSecretWidget agentId={agentId} widget={widget} />;
  }
  return null;
}

function StatusBadge({ status }: { status: WidgetEntry["status"] }) {
  const map: Record<WidgetEntry["status"], string> = {
    pending: "bg-(--color-muted)/20 text-(--color-muted)",
    done: "bg-(--color-success)/20 text-(--color-success)",
    cancelled: "bg-(--color-muted)/20 text-(--color-muted)",
    failed: "bg-(--color-danger)/20 text-(--color-danger)",
  };
  return (
    <span className={`rounded-full px-2 py-[1px] text-[10px] uppercase ${map[status]}`}>
      {status}
    </span>
  );
}

async function resolveWidget(
  agentId: string,
  widget: WidgetEntry,
  status: "done" | "cancelled" | "failed",
  result?: unknown,
): Promise<void> {
  log.info("resolve", {
    kind: widget.kind,
    action_id: widget.action_id,
    status,
  });
  useAgentStore.getState().resolveWidget(widget.action_id, status, result ?? null);
  const res = await appFetch(
    `/api/agents/${agentId}/widgets/${widget.action_id}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, result }),
    },
  );
  if (!res.ok) {
    log.error("resolve failed", { status: res.status });
    useAgentStore
      .getState()
      .resolveWidget(widget.action_id, "failed", { reason: `Resolve HTTP ${res.status}` });
    throw new Error(`Resolve failed (${res.status})`);
  }
  const json = (await res.json().catch(() => null)) as
    | { resumed_job_id?: string }
    | null;
  if (json?.resumed_job_id) {
    log.info("agent loop resumed", { job_id: json.resumed_job_id });
    // Detached attach — agent continues its loop with the widget result.
    void attachToTurn(agentId, json.resumed_job_id, 0);
  }
}

const PROVIDER_DOCS: Record<string, { docsUrl: string; tokenLabel: string }> = {
  hubspot: {
    docsUrl: "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
    tokenLabel: "Private App access token",
  },
};

function ConnectIntegrationWidget({
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
  const docs = PROVIDER_DOCS[payload.provider];
  const supportsToken = Boolean(docs);

  const submit = async () => {
    setError(null);
    if (supportsToken) {
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
    } else {
      setBusy(true);
      try {
        await resolveWidget(agentId, widget, "done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setBusy(false);
      }
    }
  };

  const cancel = async () => {
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

  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) p-4 shadow-md">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">Connect {prettify(payload.provider)}</h4>
          <p className="mt-1 text-xs text-(--color-muted)">{payload.reason}</p>
        </div>
        <StatusBadge status={widget.status} />
      </div>
      {widget.status === "pending" && supportsToken && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs font-medium text-(--color-foreground)">
            Paste your {docs.tokenLabel}
          </label>
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={busy}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            rows={3}
            placeholder="pat-na1-..."
            className="w-full resize-none rounded-lg border border-(--color-border) bg-(--color-panel) px-3 py-2 font-mono text-xs outline-none focus:border-(--color-accent)"
          />
          <a
            href={docs.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-[11px] text-(--color-accent) hover:underline"
          >
            How to create one →
          </a>
          <div className="mt-2 flex gap-2">
            <button
              disabled={busy || token.trim().length === 0}
              onClick={submit}
              className="rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-semibold text-(--color-accent-foreground) disabled:opacity-50"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
            <button
              disabled={busy}
              onClick={cancel}
              className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground)"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {widget.status === "pending" && !supportsToken && (
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            onClick={submit}
            className="rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-semibold text-(--color-accent-foreground)"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
          <button
            disabled={busy}
            onClick={cancel}
            className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground)"
          >
            Skip
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-(--color-danger)">{error}</p>}
    </div>
  );
}

function ConfirmWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as {
    question: string;
    confirm_label?: string;
    cancel_label?: string;
  };
  const [busy, setBusy] = useState(false);
  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) p-4 shadow-md">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{payload.question}</p>
        <StatusBadge status={widget.status} />
      </div>
      {widget.status === "pending" && (
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resolveWidget(agentId, widget, "done", { value: "yes" });
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-semibold text-(--color-accent-foreground)"
          >
            {payload.confirm_label ?? "Yes"}
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resolveWidget(agentId, widget, "cancelled", { value: "no" });
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-full px-4 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground)"
          >
            {payload.cancel_label ?? "No"}
          </button>
        </div>
      )}
    </div>
  );
}

function PickOptionWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as {
    question: string;
    options: Array<{ value: string; label: string }>;
  };
  const [busy, setBusy] = useState(false);
  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) p-4 shadow-md">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{payload.question}</p>
        <StatusBadge status={widget.status} />
      </div>
      {widget.status === "pending" && (
        <div className="mt-3 flex flex-wrap gap-2">
          {payload.options.map((o) => (
            <button
              key={o.value}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await resolveWidget(agentId, widget, "done", { value: o.value });
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-full border border-(--color-border) px-3 py-1 text-xs hover:bg-(--color-panel)"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CollectSecretWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as {
    name: string;
    title: string;
    description: string;
    placeholder?: string;
    docs_url?: string;
  };
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = value.trim();
    if (trimmed.length < 4) {
      setError("That value looks too short. Paste the full secret.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Submit through the existing widget resolve endpoint. The plaintext
      // travels over HTTPS once, the server encrypts and persists, then it
      // is dropped from memory. We replace local state with an empty string
      // immediately on submit so the value doesn't linger in React DevTools.
      await resolveWidget(agentId, widget, "done", { value: trimmed });
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await resolveWidget(agentId, widget, "cancelled");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) p-4 shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-(--color-foreground-strong)">
            {payload.title}
          </h4>
          <p className="mt-1 whitespace-pre-line text-xs text-(--color-muted)">
            {payload.description}
          </p>
          <p className="mt-1 font-mono text-[10px] text-(--color-muted-soft)">
            secret_ref: {payload.name}
          </p>
        </div>
        <StatusBadge status={widget.status} />
      </div>
      {widget.status === "pending" && (
        <div className="mt-3 space-y-2">
          <div className="relative">
            <input
              type={revealed ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              placeholder={payload.placeholder ?? "Paste the value…"}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              className="w-full rounded-lg border border-(--color-border) bg-(--color-panel) px-3 py-2 pr-16 font-mono text-xs outline-none focus:border-(--color-accent)"
            />
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-[10px] uppercase tracking-wider text-(--color-muted) hover:text-(--color-foreground)"
              aria-label={revealed ? "Hide secret" : "Show secret"}
            >
              {revealed ? "Hide" : "Show"}
            </button>
          </div>
          {payload.docs_url && (
            <a
              href={payload.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[11px] text-(--color-accent) hover:underline"
            >
              Where do I find this? →
            </a>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={busy || value.trim().length === 0}
              onClick={submit}
              className="rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-semibold text-(--color-accent-foreground) disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={cancel}
              className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground)"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {widget.status === "done" && (
        <p className="mt-2 text-xs text-(--color-success)">
          Saved. The agent can now use this value via {payload.name}.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-(--color-danger)">{error}</p>}
    </div>
  );
}

function prettify(slug: string): string {
  return slug
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
