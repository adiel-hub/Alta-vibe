"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { appFetch } from "@/lib/apiClient";
import type { WidgetEntry } from "@/store/agentStore";
import { ResolvedPill, WidgetFrame } from "../_shared/WidgetFrame";
import { resolveWidget } from "../_shared/resolveWidget";
import { parseCsv } from "@/lib/csv/parse";
import {
  CANONICAL_FIELDS_ORDERED,
  applyMapping,
  autoDetectMapping,
  labelFor,
  validateMapping,
  type CanonicalField,
  type ColumnMapping,
  type FieldTarget,
} from "@/lib/csv/mapping";

type Payload = {
  title?: string;
  /**
   * When set (csv-attach endpoint pre-loads the user's file content here),
   * the widget skips the upload step and opens directly on the mapping
   * screen with the CSV already parsed.
   */
  prefill_text?: string;
};

type AudienceOption = { id: string; name: string; prospect_count: number };

type Step = "upload" | "map";

// Sentinel select values — encode FieldTarget as a string so the dropdown
// can hand back a typed update via parseTargetValue().
const IGNORE_VALUE = "__ignore__";
const CUSTOM_VALUE = "__custom__";

function parseTargetValue(value: string, customName: string): FieldTarget {
  if (value === IGNORE_VALUE) return { kind: "ignore" };
  if (value === CUSTOM_VALUE) return { kind: "custom", name: customName };
  return {
    kind: "canonical",
    field: value as (typeof CANONICAL_FIELDS_ORDERED)[number],
  };
}

function serializeTarget(target: FieldTarget): string {
  if (target.kind === "ignore") return IGNORE_VALUE;
  if (target.kind === "custom") return CUSTOM_VALUE;
  return target.field;
}

export function CsvUploadWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = (widget.payload ?? {}) as Payload;
  const prefill = payload.prefill_text ?? "";
  const [text, setText] = useState<string>(prefill);
  const [step, setStep] = useState<Step>(prefill ? "map" : "upload");
  const [mapping, setMapping] = useState<ColumnMapping>(() => {
    // Seed the mapping on first render when we have prefilled text so the
    // map step renders with auto-detected fields instead of all-ignore.
    if (!prefill.trim()) return {};
    try {
      const { headers } = parseCsv(prefill);
      return autoDetectMapping(headers);
    } catch {
      return {};
    }
  });
  const [audiences, setAudiences] = useState<AudienceOption[] | null>(null);
  const [audienceMode, setAudienceMode] = useState<"existing" | "new">("new");
  const [pickedId, setPickedId] = useState<string>("");
  const [newName, setNewName] = useState<string>(() =>
    payload.title ? payload.title.replace(/\.csv$/i, "") : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch("/api/audiences");
        if (!res.ok) return;
        const json = (await res.json()) as { audiences?: AudienceOption[] };
        if (cancelled) return;
        const list = json.audiences ?? [];
        setAudiences(list);
        if (list.length > 0) {
          setAudienceMode("existing");
          setPickedId(list[0].id);
        }
      } catch {
        if (!cancelled) setAudiences([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Parse CSV once per text change — independent of mapping.
  const parsedCsv = useMemo(() => {
    if (!text.trim()) return { headers: [], rows: [] };
    try {
      return parseCsv(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV parse failed");
      return { headers: [], rows: [] };
    }
  }, [text]);

  // Re-derive prospects whenever the mapping or rows change.
  const derived = useMemo(() => {
    if (parsedCsv.headers.length === 0) {
      return { prospects: [], skipped: 0 };
    }
    const prospects: ReturnType<typeof applyMapping>[] = [];
    let skipped = 0;
    for (const r of parsedCsv.rows) {
      const p = applyMapping(r, mapping);
      if (p) prospects.push(p);
      else skipped++;
    }
    return {
      prospects: prospects.filter((p): p is NonNullable<typeof p> => p !== null),
      skipped,
    };
  }, [parsedCsv, mapping]);

  const validation = useMemo(() => validateMapping(mapping), [mapping]);

  const onFile = async (file: File) => {
    setError(null);
    const content = await file.text();
    advanceToMapping(content, file.name.replace(/\.csv$/i, ""));
  };

  const advanceToMapping = (content: string, suggestedAudienceName?: string) => {
    setText(content);
    try {
      const { headers } = parseCsv(content);
      if (headers.length === 0) {
        setError("CSV appears empty.");
        return;
      }
      setMapping(autoDetectMapping(headers));
      setStep("map");
      if (suggestedAudienceName && !newName.trim()) {
        setNewName(suggestedAudienceName);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV parse failed");
    }
  };

  const canSubmit =
    step === "map" &&
    derived.prospects.length > 0 &&
    validation.ok &&
    !busy &&
    ((audienceMode === "existing" && pickedId) ||
      (audienceMode === "new" && newName.trim()));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await resolveWidget(agentId, widget, "done", {
        prospects: derived.prospects,
        audience:
          audienceMode === "existing"
            ? { id: pickedId }
            : { new_name: newName.trim() },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await resolveWidget(agentId, widget, "cancelled");
    } catch {
      setBusy(false);
    }
  };

  const audienceLabel =
    audienceMode === "existing"
      ? audiences?.find((a) => a.id === pickedId)?.name ?? "—"
      : newName.trim() || "—";

  const doneResult =
    widget.status === "done"
      ? ((widget.result ?? {}) as {
          prospects?: unknown[];
          audience?: { id?: string; new_name?: string };
        })
      : null;
  const doneCount = Array.isArray(doneResult?.prospects)
    ? doneResult.prospects.length
    : 0;
  const doneAudienceName =
    doneResult?.audience?.new_name ?? doneResult?.audience?.id ?? "audience";

  return (
    <WidgetFrame
      widget={widget}
      title={payload.title ?? "Upload prospects CSV"}
      description={
        step === "upload"
          ? "Pick a CSV — any column names. You'll map them to fields in the next step."
          : "Map each column to a field. Phone is required; everything else is optional or can be kept as a custom field."
      }
      resolvedSummary={
        doneResult ? (
          <ResolvedPill>
            Imported {doneCount} · {doneAudienceName}
          </ResolvedPill>
        ) : undefined
      }
    >
      {step === "upload" && (
        <UploadStep
          text={text}
          setText={setText}
          onFile={onFile}
          onContinue={() => advanceToMapping(text)}
          busy={busy}
          error={error}
        />
      )}

      {step === "map" && (
        <MapStep
          headers={parsedCsv.headers}
          mapping={mapping}
          setMapping={setMapping}
          validation={validation}
          dialableCount={derived.prospects.length}
          audiences={audiences}
          audienceMode={audienceMode}
          setAudienceMode={setAudienceMode}
          pickedId={pickedId}
          setPickedId={setPickedId}
          newName={newName}
          setNewName={setNewName}
          actionId={widget.action_id}
          busy={busy}
          error={error}
          audienceLabel={audienceLabel}
          canSubmit={!!canSubmit}
          onSubmit={submit}
          onCancel={cancel}
        />
      )}
    </WidgetFrame>
  );
}

function UploadStep({
  text,
  setText,
  onFile,
  onContinue,
  busy,
  error,
}: {
  text: string;
  setText: (v: string) => void;
  onFile: (f: File) => Promise<void>;
  onContinue: () => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <>
      <div className="mt-3 flex items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-(--color-border) bg-white px-3 py-1.5 text-xs hover:bg-(--color-panel-soft)">
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          Choose file…
        </label>
        <span className="text-[11px] text-(--color-muted)">or paste below</span>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
        rows={5}
        placeholder={"name,phone,company,title\nAda Lovelace,+15551234567,Acme,CTO"}
        className="mt-2 w-full rounded-md border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 font-mono text-[11px] outline-none focus:border-(--color-accent)/60"
      />

      {error && <p className="mt-2 text-[11px] text-(--color-danger)">{error}</p>}

      <div className="mt-3 flex justify-end gap-2">
        <Button disabled={busy || !text.trim()} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </>
  );
}

function MapStep({
  headers,
  mapping,
  setMapping,
  validation,
  dialableCount,
  audiences,
  audienceMode,
  setAudienceMode,
  pickedId,
  setPickedId,
  newName,
  setNewName,
  actionId,
  busy,
  error,
  audienceLabel,
  canSubmit,
  onSubmit,
  onCancel,
}: {
  headers: string[];
  mapping: ColumnMapping;
  setMapping: (updater: (prev: ColumnMapping) => ColumnMapping) => void;
  validation: { ok: boolean; errors: string[] };
  dialableCount: number;
  audiences: AudienceOption[] | null;
  audienceMode: "existing" | "new";
  setAudienceMode: (m: "existing" | "new") => void;
  pickedId: string;
  setPickedId: (v: string) => void;
  newName: string;
  setNewName: (v: string) => void;
  actionId: string;
  busy: boolean;
  error: string | null;
  audienceLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const updateTarget = (header: string, next: FieldTarget) => {
    setMapping((prev) => ({ ...prev, [header]: next }));
  };

  const isActive = (h: string) =>
    (mapping[h]?.kind ?? "ignore") !== "ignore";
  const activeHeaders = headers.filter(isActive);
  const ignoredHeaders = headers.filter((h) => !isActive(h));

  const addMapping = (header: string) => {
    if (!header) return;
    // Default to Custom (with the header as the field name) so we never
    // silently steal another row's canonical target. The user picks the
    // real meaning via the right-side dropdown.
    updateTarget(header, { kind: "custom", name: header });
  };

  return (
    <>
      <div className="mt-3 grid grid-cols-[1fr_24px_1fr_28px] items-center gap-2 px-1 text-[11px] font-medium text-(--color-muted)">
        <div className="flex items-center gap-1.5">
          <FileIcon />
          <span>CSV</span>
        </div>
        <div />
        <div className="flex items-center gap-1.5">
          <SparkleIcon />
          <span>Alta</span>
        </div>
        <div />
      </div>

      <div className="mt-1.5 space-y-1.5">
        {activeHeaders.map((header) => {
          const target = mapping[header] ?? { kind: "ignore" };
          return (
            <MappingRow
              key={header}
              header={header}
              target={target}
              busy={busy}
              onChangeTarget={(next) => updateTarget(header, next)}
              onRemove={() => updateTarget(header, { kind: "ignore" })}
            />
          );
        })}
      </div>

      {ignoredHeaders.length > 0 && (
        <div className="mt-2">
          <AddMappingButton
            options={ignoredHeaders}
            disabled={busy}
            onAdd={addMapping}
          />
        </div>
      )}

      {!validation.ok && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-(--color-danger)">
          {validation.errors.map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-(--color-muted)">
          Add to audience
        </div>
        {audiences && audiences.length > 0 && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="radio"
              name={`csv-${actionId}`}
              checked={audienceMode === "existing"}
              onChange={() => setAudienceMode("existing")}
              disabled={busy}
            />
            <span>Existing</span>
            <select
              disabled={busy || audienceMode !== "existing"}
              value={pickedId}
              onChange={(e) => setPickedId(e.target.value)}
              className="flex-1 rounded-md border border-(--color-border) bg-white px-2 py-1 text-xs"
            >
              {audiences.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.prospect_count})
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-xs">
          {audiences && audiences.length > 0 ? (
            <input
              type="radio"
              name={`csv-${actionId}`}
              checked={audienceMode === "new"}
              onChange={() => setAudienceMode("new")}
              disabled={busy}
            />
          ) : null}
          <span>{audiences && audiences.length > 0 ? "New" : "Audience name"}</span>
          <input
            type="text"
            dir="auto"
            value={newName}
            disabled={busy || audienceMode !== "new"}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g., Q2 Inbound list"
            className="flex-1 rounded-md border border-(--color-border) bg-white px-2 py-1 text-xs outline-none placeholder:text-(--color-muted) focus:border-(--color-accent)/60"
          />
        </label>
      </div>

      {error && <p className="mt-2 text-[11px] text-(--color-danger)">{error}</p>}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground-strong)"
        >
          Cancel
        </button>
        <Button disabled={!canSubmit} onClick={onSubmit}>
          Add {dialableCount} to {audienceLabel}
        </Button>
      </div>
    </>
  );
}

function MappingRow({
  header,
  target,
  busy,
  onChangeTarget,
  onRemove,
}: {
  header: string;
  target: FieldTarget;
  busy: boolean;
  onChangeTarget: (next: FieldTarget) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_24px_1fr_28px] items-center gap-2">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2">
        <FileIcon className="shrink-0 text-(--color-muted)" />
        <span className="truncate font-mono text-xs text-(--color-foreground-strong)">
          {header}
        </span>
      </div>

      <div className="flex justify-center text-(--color-muted-soft)">
        <ArrowIcon />
      </div>

      <div className="relative">
        {target.kind === "custom" ? (
          <CustomFieldCard
            target={target}
            busy={busy}
            onChange={onChangeTarget}
            originalHeader={header}
          />
        ) : (
          <CanonicalFieldCard
            target={target}
            busy={busy}
            onChange={onChangeTarget}
            originalHeader={header}
          />
        )}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={onRemove}
        aria-label="Remove mapping"
        title="Remove mapping"
        className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-danger) disabled:cursor-not-allowed disabled:text-(--color-muted-soft)"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function CanonicalFieldCard({
  target,
  busy,
  onChange,
  originalHeader,
}: {
  target: FieldTarget;
  busy: boolean;
  onChange: (next: FieldTarget) => void;
  originalHeader: string;
}) {
  const field =
    target.kind === "canonical" ? target.field : null;
  return (
    <label className="flex items-center gap-2 rounded-lg border border-(--color-border) bg-white px-3 py-2 transition focus-within:border-(--color-accent) focus-within:shadow-[0_0_0_3px_rgba(79,70,229,0.08)] has-disabled:bg-(--color-panel-soft)">
      <span className="shrink-0 text-(--color-muted)">
        <FieldIcon field={field} />
      </span>
      <span className="truncate text-xs text-(--color-foreground-strong)">
        {field ? labelFor(field) : "Select…"}
      </span>
      <ChevronIcon className="ml-auto shrink-0 text-(--color-muted-soft)" />
      <select
        disabled={busy}
        value={serializeTarget(target)}
        onChange={(e) =>
          onChange(parseTargetValue(e.target.value, originalHeader))
        }
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        aria-label="Map to field"
      >
        <optgroup label="Canonical">
          {CANONICAL_FIELDS_ORDERED.map((f) => (
            <option key={f} value={f}>
              {labelFor(f)}
              {f === "phone" ? " (required)" : ""}
            </option>
          ))}
        </optgroup>
        <option value={CUSTOM_VALUE}>Custom field…</option>
        <option value={IGNORE_VALUE}>Remove</option>
      </select>
    </label>
  );
}

function CustomFieldCard({
  target,
  busy,
  onChange,
  originalHeader,
}: {
  target: FieldTarget & { kind: "custom" };
  busy: boolean;
  onChange: (next: FieldTarget) => void;
  originalHeader: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-(--color-border) bg-white px-3 py-2 transition focus-within:border-(--color-accent) focus-within:shadow-[0_0_0_3px_rgba(79,70,229,0.08)]">
      <span className="shrink-0 text-(--color-muted)">
        <CustomIcon />
      </span>
      <input
        type="text"
        dir="auto"
        disabled={busy}
        value={target.name}
        onChange={(e) =>
          onChange({ kind: "custom", name: e.target.value })
        }
        placeholder="Field name"
        className="min-w-0 flex-1 bg-transparent text-xs text-(--color-foreground-strong) outline-none placeholder:text-(--color-muted)"
      />
      <div className="relative shrink-0">
        <ChevronIcon className="text-(--color-muted-soft)" />
        <select
          disabled={busy}
          value={CUSTOM_VALUE}
          onChange={(e) =>
            onChange(parseTargetValue(e.target.value, originalHeader))
          }
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          aria-label="Change mapping type"
        >
          <optgroup label="Canonical">
            {CANONICAL_FIELDS_ORDERED.map((f) => (
              <option key={f} value={f}>
                {labelFor(f)}
                {f === "phone" ? " (required)" : ""}
              </option>
            ))}
          </optgroup>
          <option value={CUSTOM_VALUE}>Custom field…</option>
          <option value={IGNORE_VALUE}>Remove</option>
        </select>
      </div>
    </div>
  );
}

function AddMappingButton({
  options,
  disabled,
  onAdd,
}: {
  options: string[];
  disabled: boolean;
  onAdd: (header: string) => void;
}) {
  return (
    <div className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-(--color-border) bg-transparent px-3 py-1.5 text-xs text-(--color-muted) transition hover:border-(--color-accent)/60 hover:text-(--color-foreground-strong) disabled:cursor-not-allowed disabled:opacity-50"
      >
        <PlusIcon />
        Add mapping
      </button>
      <select
        disabled={disabled}
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
          e.target.value = "";
        }}
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        aria-label="Add a CSV column to map"
      >
        <option value="" disabled>
          Pick a column…
        </option>
        {options.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );
}

// --- Icons ----------------------------------------------------------------

function FileIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function SparkleIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function AtIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function AaIcon() {
  return (
    <span className="grid h-3.5 w-3.5 place-items-center text-[10px] font-semibold leading-none text-current">
      Aa
    </span>
  );
}

function CustomIcon() {
  return <FileIcon />;
}

function FieldIcon({ field }: { field: CanonicalField | null }) {
  if (field === "phone") return <PhoneIcon />;
  if (field === "email") return <AtIcon />;
  if (field === "linkedin_url") return <LinkIcon />;
  if (field === "location") return <MapPinIcon />;
  if (field === null) return <AaIcon />;
  return <AaIcon />;
}
