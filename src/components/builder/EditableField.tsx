"use client";

import { useEffect, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import type { AgentConfigCache } from "@/types/agent";

type Props = {
  agentId: string;
  field: keyof AgentConfigCache;
  label: string;
  value: string;
  multiline?: boolean;
  rows?: number;
  busy?: boolean;
  placeholder?: string;
  validate?: (v: string) => string | null;
};

export function EditableField({
  agentId,
  field,
  label,
  value,
  multiline,
  rows,
  busy,
  placeholder,
  validate,
}: Props) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const save = async () => {
    const err = validate ? validate(draft) : null;
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: draft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Save failed (${res.status})`);
      }
      const json = (await res.json()) as { revision: number };
      applyConfigDirect({ [field]: draft } as Partial<AgentConfigCache>, json.revision);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          {label}
        </h3>
        <div className="flex items-center gap-2">
          {busy && <span className="text-xs text-(--color-accent)">syncing…</span>}
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-(--color-muted) hover:text-(--color-foreground)"
            >
              edit
            </button>
          )}
        </div>
      </div>
      {!editing ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {value || <span className="text-(--color-muted)">{placeholder ?? "—"}</span>}
        </p>
      ) : (
        <div className="space-y-2">
          {multiline ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={rows ?? 6}
              className="w-full rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
            />
          ) : (
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
            />
          )}
          {error && <p className="text-xs text-(--color-danger)">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={saving}
              className="rounded-full px-3 py-1 text-xs text-(--color-muted) hover:text-(--color-foreground)"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-full bg-(--color-accent) px-3 py-1 text-xs font-semibold text-(--color-accent-foreground)"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
