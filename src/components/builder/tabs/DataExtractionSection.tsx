"use client";

/**
 * Data-extraction editor. Sibling of the Call Outcomes section in the
 * Post-call analysis tab. Where call outcomes are scored yes/no, these
 * fields extract concrete typed values per call — surfaced under
 * `analysis.data_collection_results` on the call log row.
 *
 * Wire path: `/api/agents/[id]/data-collection` (POST) and
 * `[fieldId]/route.ts` (PATCH / DELETE). Both keep the agent's
 * `config_cache.data_collection` in sync with ElevenLabs'
 * `platform_settings.data_collection`.
 *
 * Edit constraints: rename is intentionally not exposed. The field name
 * IS the upstream Record key + the id we ship to call-log consumers, so
 * mutating it would orphan historical extraction results. Users can
 * delete + recreate when they want a new identifier.
 */
import { useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import type { DataCollectionField } from "@/types/agent";

type FieldType = "string" | "number" | "integer" | "boolean";

type DraftField = {
  name: string;
  type: FieldType;
  description: string;
  /** Allowed values shown as chips. Kept as the canonical shape end-to-end
   *  so we don't have to repeatedly parse + dedupe a comma-separated blob. */
  enumValues: string[];
};

const EMPTY_DRAFT: DraftField = {
  name: "",
  type: "string",
  description: "",
  enumValues: [],
};

type ApiResponse = {
  revision: number;
  patch: { data_collection: DataCollectionField[] };
  field?: DataCollectionField;
};

export function DataExtractionSection({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<DraftField>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!config) return null;
  const fields = config.data_collection ?? [];

  const handle = async (run: () => Promise<Response>, key: string) => {
    setError(null);
    setBusy(key);
    try {
      const res = await run();
      const body = (await res.json().catch(() => null)) as
        | (ApiResponse & { error?: string })
        | null;
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      if (body) applyConfigDirect(body.patch, body.revision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async () => {
    if (!draft.name.trim() || draft.description.trim().length < 1) {
      setError("Name and description are both required.");
      return;
    }
    try {
      await handle(
        () =>
          appFetch(`/api/agents/${agentId}/data-collection`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: draft.name.trim(),
              type: draft.type,
              description: draft.description.trim(),
              ...(draft.enumValues.length > 0
                ? { enum: draft.enumValues }
                : {}),
            }),
          }),
        "create",
      );
      setDraft(EMPTY_DRAFT);
      setCreating(false);
    } catch {
      /* error already surfaced */
    }
  };

  const onUpdate = async (
    fieldId: string,
    next: { type?: FieldType; description?: string; enum?: string[] },
  ) => {
    await handle(
      () =>
        appFetch(`/api/agents/${agentId}/data-collection/${fieldId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        }),
      fieldId,
    );
  };

  const onDelete = async (fieldId: string) => {
    await handle(
      () =>
        appFetch(`/api/agents/${agentId}/data-collection/${fieldId}`, {
          method: "DELETE",
        }),
      fieldId,
    );
  };

  return (
    <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
      <div className="mb-1 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Data extraction
          </h3>
          <p className="mt-1 text-[12px] text-(--color-muted)">
            Typed values pulled from each call (e.g. order_number, callback_time,
            resolved). Results land on the call log under
            <span className="font-mono"> data_collection_results</span>.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {fields.map((f, i) => (
          <div
            key={f.id}
            style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
            className="animate-message-in"
          >
            <FieldRow
              field={f}
              busy={busy === f.id}
              onSave={(next) => onUpdate(f.id, next)}
              onDelete={() => onDelete(f.id)}
            />
          </div>
        ))}

        {creating ? (
          <FieldDraftRow
            draft={draft}
            setDraft={setDraft}
            busy={busy === "create"}
            onCancel={() => {
              setDraft(EMPTY_DRAFT);
              setCreating(false);
              setError(null);
            }}
            onSave={onCreate}
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="group inline-flex items-center gap-2 rounded-xl border border-dashed border-(--color-border) bg-(--color-panel-soft) px-4 py-3 text-sm font-medium text-(--color-muted) transition hover:border-(--color-accent) hover:text-(--color-accent)"
          >
            <PlusIcon />
            Add extraction field
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-(--color-danger) bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────

function FieldRow({
  field,
  busy,
  onSave,
  onDelete,
}: {
  field: DataCollectionField;
  busy: boolean;
  onSave: (next: {
    type?: FieldType;
    description?: string;
    enum?: string[];
  }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftField>({
    name: field.name,
    type: field.type,
    description: field.description,
    enumValues: field.enum ?? [],
  });

  const save = async () => {
    if (draft.description.trim().length < 1) return;
    await onSave({
      type: draft.type,
      description: draft.description.trim(),
      // Always send the array — empty array explicitly clears the
      // constraint on the server side (see [fieldId]/route.ts).
      enum: draft.enumValues,
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="rounded-xl border border-(--color-accent) bg-(--color-panel) p-4">
        <FieldDraftFields draft={draft} setDraft={setDraft} renameLocked />
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft({
                name: field.name,
                type: field.type,
                description: field.description,
                enumValues: field.enum ?? [],
              });
              setEditing(false);
            }}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-(--color-muted) transition hover:bg-(--color-panel-soft)"
          >
            Cancel
          </button>
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start justify-between gap-3 rounded-xl border border-(--color-border) bg-(--color-panel) px-4 py-3 transition hover:border-(--color-border-strong)">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <FieldIcon />
          <span
            dir="auto"
            className="font-mono text-sm font-semibold text-(--color-foreground-strong)"
          >
            {field.name}
          </span>
          <span className="rounded-full bg-(--color-panel-soft) px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-muted)">
            {field.enum && field.enum.length > 0 ? "enum" : field.type}
          </span>
        </div>
        <p
          dir="auto"
          className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-(--color-muted)"
        >
          {field.description}
        </p>
        {field.enum && field.enum.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {field.enum.map((v) => (
              <span
                key={v}
                className="rounded-full border border-(--color-border) bg-(--color-panel-soft) px-2 py-0.5 font-mono text-[10px] text-(--color-foreground)"
              >
                {v}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Edit"
          aria-label="Edit"
          className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
        >
          <PencilIcon />
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          title="Delete"
          aria-label="Delete"
          className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-danger)/10 hover:text-(--color-danger) disabled:opacity-50"
        >
          {busy ? <span className="text-[10px]">…</span> : <TrashIcon />}
        </button>
      </div>
    </div>
  );
}

// ── Draft row ───────────────────────────────────────────────────────────

function FieldDraftRow({
  draft,
  setDraft,
  busy,
  onCancel,
  onSave,
}: {
  draft: DraftField;
  setDraft: (d: DraftField) => void;
  busy: boolean;
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-(--color-accent) bg-(--color-panel) p-4">
      <FieldDraftFields draft={draft} setDraft={setDraft} />
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-(--color-muted) transition hover:bg-(--color-panel-soft)"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="rounded-md bg-(--color-accent) px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create field"}
        </button>
      </div>
    </div>
  );
}

function FieldDraftFields({
  draft,
  setDraft,
  renameLocked,
}: {
  draft: DraftField;
  setDraft: (d: DraftField) => void;
  renameLocked?: boolean;
}) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
          Field name
        </span>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          disabled={renameLocked}
          placeholder="order_number"
          maxLength={80}
          className="mt-1 w-full rounded-md border border-(--color-border) bg-(--color-panel) px-3 py-2 font-mono text-sm focus:border-(--color-accent) focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="mt-1 block text-[11px] text-(--color-muted-soft)">
          {renameLocked
            ? "Name is fixed — delete + recreate to rename so historical call-log values stay addressable."
            : "snake_case. Used as the key in call-log results."}
        </span>
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
          Description
        </span>
        <textarea
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="The order number the caller referenced, or null if they didn't provide one."
          rows={3}
          maxLength={500}
          className="mt-1 w-full resize-y rounded-md border border-(--color-border) bg-(--color-panel) px-3 py-2 text-sm leading-relaxed focus:border-(--color-accent) focus:outline-none"
        />
        <span className="mt-1 block text-[11px] text-(--color-muted-soft)">
          The LLM reads this to know what to extract. Be specific about
          format and what to do when the value isn't mentioned.
        </span>
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
          Type
        </span>
        <div className="mt-1 grid grid-cols-4 gap-1 rounded-md border border-(--color-border) bg-(--color-panel-soft) p-1">
          {(["string", "number", "integer", "boolean"] as const).map((t) => {
            const selected = draft.type === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setDraft({ ...draft, type: t })}
                className={`rounded-md py-1.5 text-xs font-mono transition ${
                  selected
                    ? "bg-(--color-panel) font-medium text-(--color-foreground-strong) shadow-sm"
                    : "text-(--color-muted) hover:text-(--color-foreground)"
                }`}
              >
                {t}
              </button>
            );
          })}
        </div>
      </label>
      <div>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
          Allowed values (optional)
        </span>
        <EnumChipsInput
          values={draft.enumValues}
          onChange={(next) => setDraft({ ...draft, enumValues: next })}
        />
        <span className="mt-1 block text-[11px] text-(--color-muted-soft)">
          Press comma or Enter to add. When set, the extractor must return
          one of these exactly. Leave blank for free-form values.
        </span>
      </div>
    </div>
  );
}

// ── Chip input ──────────────────────────────────────────────────────────

/**
 * Tags-style input: the typed text becomes a chip on comma or Enter; Backspace
 * on empty input pulls the last chip back into the buffer so it can be edited.
 * Pasting "a, b, c" splits into three chips in one go. Dedupes against the
 * existing values (case-insensitive) so a slip of the keyboard doesn't make
 * `["pro", "pro"]`.
 */
function EnumChipsInput({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [buffer, setBuffer] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const parts = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) return;
    const seen = new Set(values.map((v) => v.toLowerCase()));
    const next = [...values];
    for (const p of parts) {
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(p);
    }
    if (next.length !== values.length) onChange(next);
  };

  const removeAt = (idx: number) => {
    const next = values.slice();
    next.splice(idx, 1);
    onChange(next);
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className="mt-1 flex w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-(--color-border) bg-(--color-panel) px-2 py-1.5 focus-within:border-(--color-accent)"
    >
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          className="inline-flex items-center gap-1 rounded-full bg-(--color-accent)/10 px-2 py-0.5 font-mono text-xs text-(--color-accent)"
        >
          <span dir="auto">{v}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removeAt(i);
            }}
            aria-label={`Remove ${v}`}
            className="grid h-3.5 w-3.5 place-items-center rounded-full text-(--color-accent) transition hover:bg-(--color-accent)/20"
          >
            <XIcon />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        dir="auto"
        value={buffer}
        onChange={(e) => {
          const v = e.target.value;
          // A trailing separator commits the prefix as chips and keeps any
          // remainder in the buffer (handles paste of "a, b, c" cleanly).
          if (/[,\n]/.test(v)) {
            const segs = v.split(/[,\n]/);
            const tail = segs.pop() ?? "";
            commit(segs.join(","));
            setBuffer(tail);
          } else {
            setBuffer(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (buffer.trim().length > 0) {
              commit(buffer);
              setBuffer("");
            }
          } else if (
            e.key === "Backspace" &&
            buffer.length === 0 &&
            values.length > 0
          ) {
            // Pull the last chip back into the buffer for quick edit.
            const next = values.slice(0, -1);
            const last = values[values.length - 1];
            onChange(next);
            setBuffer(last);
          }
        }}
        onBlur={() => {
          if (buffer.trim().length > 0) {
            commit(buffer);
            setBuffer("");
          }
        }}
        placeholder={values.length === 0 ? "basic, pro, enterprise" : ""}
        className="flex-1 min-w-[120px] bg-transparent py-0.5 font-mono text-sm outline-none placeholder:text-(--color-muted-soft)"
      />
    </div>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function FieldIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-(--color-accent)"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M9 4v16" />
    </svg>
  );
}
