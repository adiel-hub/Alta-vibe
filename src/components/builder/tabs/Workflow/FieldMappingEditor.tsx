import { useEffect, useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type { AgentConfigCache, RuntimeTool } from "@/types/agent";
import {
  loadFieldMappingMetaCached,
  type FieldMappingMeta,
} from "./_shared/providerIconsCache";

type Mapping = { property: string; variable: string };
type Row = Mapping & { kind: "default" | "custom" };
type PropertyOption = { name: string; label: string; type: string };

/** Slugify a property name into a safe dynamic-variable identifier. */
function toVariable(property: string): string {
  const slug = property
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return "";
  return /^[a-z_]/.test(slug) ? slug : `field_${slug}`;
}

const VAR_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const normalize = (m: Mapping[]) =>
  JSON.stringify([...m].sort((a, b) => a.variable.localeCompare(b.variable)));

/**
 * Per-agent field-mapping editor for a pre-call provider tool. Shows the full
 * mapping CSV-style (provider property → Alta variable): the built-in defaults
 * with an editable property dropdown (variable name locked) plus custom rows
 * users add. Only changed defaults + customs persist to the binding; runtime
 * enrichment merges them over the spec defaults. Renders nothing unless the
 * tool's spec declares a `field_mapping`.
 */
export type FieldMappingState = {
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
};

export function FieldMappingEditor({
  agentId,
  tool,
  onStateChange,
  saveRef,
}: {
  agentId: string;
  tool: RuntimeTool;
  /** Reports save-related state up so the modal footer can host the button. */
  onStateChange?: (s: FieldMappingState) => void;
  /** Parent-owned ref the editor fills with its latest save() each render. */
  saveRef?: { current: (() => void) | null };
}) {
  const bindings = useAgentStore((s) => s.config?.workflow?.bindings);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);

  const [meta, setMeta] = useState<FieldMappingMeta | null>(null);
  const [properties, setProperties] = useState<PropertyOption[] | null>(null);
  const [propsError, setPropsError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Saved mappings for this tool (match binding by EL tool id).
  const savedRows = useMemo<Mapping[]>(() => {
    const b = (bindings ?? []).find(
      (x) => x.kind === "provider" && x.elevenlabs_tool_id === tool.id,
    );
    return b && b.kind === "provider" ? b.field_mappings ?? [] : [];
  }, [bindings, tool.id]);

  // Does this tool support mapping? (spec-declared field_mapping via catalog)
  useEffect(() => {
    let cancelled = false;
    loadFieldMappingMetaCached(agentId)
      .then((m) => {
        if (!cancelled) setMeta(m.get(tool.name) ?? null);
      })
      .catch(() => {
        /* non-fatal — editor stays hidden */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, tool.name]);

  // Seed editable rows = mappable defaults (with any saved override applied) +
  // custom rows. Re-seed when the tool or its spec meta changes.
  useEffect(() => {
    if (!meta) return;
    const savedByVar = new Map(savedRows.map((m) => [m.variable, m.property]));
    const defaultVars = new Set(meta.defaults.map((d) => d.variable));
    const seeded: Row[] = [];
    for (const d of meta.defaults) {
      if (!d.mappable) continue;
      seeded.push({
        property: savedByVar.get(d.variable) ?? d.property,
        variable: d.variable,
        kind: "default",
      });
    }
    for (const m of savedRows) {
      if (!defaultVars.has(m.variable)) {
        seeded.push({ ...m, kind: "custom" });
      }
    }
    setRows(seeded);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.id, meta]);

  // Fetch the provider's property list once we know which object to list.
  useEffect(() => {
    if (!meta || !tool.provider) return;
    let cancelled = false;
    appFetch(
      `/api/agents/${agentId}/integrations/${tool.provider}/properties?object=${encodeURIComponent(
        meta.object,
      )}`,
    )
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as
          | { properties?: PropertyOption[]; error?: string }
          | null;
        if (cancelled) return;
        if (!r.ok || !j?.properties) {
          setPropsError(j?.error ?? `Couldn't load properties (${r.status}).`);
          return;
        }
        setProperties(j.properties);
      })
      .catch(() => {
        if (!cancelled) setPropsError("Couldn't load properties.");
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, tool.provider, meta]);

  // Derived values — guarded for `meta === null` so every hook below runs
  // unconditionally (the early return for JSX comes after the effects).
  const origByVar = new Map(
    (meta?.defaults ?? [])
      .filter((d) => d.mappable)
      .map((d) => [d.variable, d.property]),
  );

  // What we persist: changed defaults (property differs from spec) + customs.
  const toFieldMappings = (rs: Row[]): Mapping[] => {
    const out: Mapping[] = [];
    for (const r of rs) {
      if (r.kind === "default") {
        if (r.property && r.property !== origByVar.get(r.variable)) {
          out.push({ property: r.property, variable: r.variable });
        }
      } else if (r.property || r.variable) {
        out.push({ property: r.property, variable: r.variable });
      }
    }
    return out;
  };

  const computed = toFieldMappings(rows);
  const dirty = normalize(computed) !== normalize(savedRows);

  const validationError = (() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.property) return "Pick a property for every field.";
      if (r.kind === "custom") {
        if (!r.variable) return "Give each custom field a variable name.";
        if (!VAR_RE.test(r.variable))
          return `"${r.variable}" isn't a valid variable name.`;
      }
      if (seen.has(r.variable)) return `Duplicate variable "${r.variable}".`;
      seen.add(r.variable);
    }
    return null;
  })();

  const save = async () => {
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/provider-tools`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool_name: tool.name, field_mappings: computed }),
      });
      const j = (await res.json().catch(() => null)) as
        | { revision: number; patch: Partial<AgentConfigCache>; error?: string }
        | null;
      if (!res.ok || !j?.patch) {
        setSaveError(j?.error ?? `Save failed (${res.status}).`);
        return;
      }
      applyConfigDirect(j.patch, j.revision);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Expose the latest save() + report state so the modal footer hosts the
  // Save button (right side, opposite Remove).
  useEffect(() => {
    if (saveRef) saveRef.current = save;
  });
  const canSave = !!meta && dirty && !validationError;
  useEffect(() => {
    onStateChange?.({ dirty: !!meta && dirty, saving, canSave });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, dirty, saving, canSave]);

  if (!meta) return null;

  const setRow = (i: number, next: Partial<Mapping>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...next } : r)));
  const removeRow = (i: number) =>
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  const addRow = () =>
    setRows((rs) => [...rs, { property: "", variable: "", kind: "custom" }]);

  const propLabel = (name: string) =>
    properties?.find((p) => p.name === name)?.label ?? name;

  // A property dropdown (styled label + hidden native select for type-ahead).
  const renderPropertySelect = (value: string, i: number) => {
    const known = properties?.some((p) => p.name === value);
    return (
      <label className="vb-el-fieldmap-select">
        <span className="vb-el-fieldmap-select-text">
          {value ? propLabel(value) : properties ? "Select property…" : "Loading…"}
        </span>
        <ChevronIcon />
        <select
          disabled={!properties || saving}
          value={value}
          onChange={(e) => {
            const property = e.target.value;
            setRow(i, {
              property,
              ...(rows[i].kind === "custom" && !rows[i].variable
                ? { variable: toVariable(property) }
                : {}),
            });
          }}
          aria-label="Property"
        >
          <option value="" disabled>
            Select property…
          </option>
          {value && !known && <option value={value}>{value}</option>}
          {(properties ?? []).map((p) => (
            <option key={p.name} value={p.name}>
              {p.label} ({p.name})
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <div className="vb-el-fieldmap">
      <div className="vb-el-fieldmap-head">Field mapping</div>
      <div className="vb-el-fieldmap-cols">
        <span>{tool.provider} property</span>
        <span>Alta variable</span>
      </div>

      {propsError && <p className="vb-el-fieldmap-hint">{propsError}</p>}

      <div className="vb-el-fieldmap-rows">
        {rows.map((r, i) => (
          <div key={`${r.kind}:${r.variable || i}`} className="vb-el-fieldmap-row">
            {renderPropertySelect(r.property, i)}
            <span className="vb-el-fieldmap-arrow" aria-hidden>
              →
            </span>
            {r.kind === "default" ? (
              <code className="vb-el-fieldmap-varlocked" title={r.variable}>
                {r.variable}
              </code>
            ) : (
              <input
                type="text"
                dir="auto"
                disabled={saving}
                value={r.variable}
                onChange={(e) => setRow(i, { variable: e.target.value })}
                placeholder="variable_name"
                className="vb-el-fieldmap-var"
                aria-label="Variable name"
              />
            )}
            {r.kind === "custom" ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => removeRow(i)}
                aria-label="Remove field"
                title="Remove field"
                className="vb-el-fieldmap-remove"
              >
                ✕
              </button>
            ) : (
              <span className="vb-el-fieldmap-remove-spacer" aria-hidden />
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={addRow}
        className="vb-el-fieldmap-add"
      >
        + Add field
      </button>

      {saveError && <p className="vb-el-fieldmap-error">{saveError}</p>}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg
      className="vb-el-fieldmap-chev"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
