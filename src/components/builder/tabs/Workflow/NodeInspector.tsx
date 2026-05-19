import { useEffect, useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type {
  AgentConfigCache,
  WorkflowEdge,
  WorkflowNode,
} from "@/types/agent";
import { ICON } from "./_shared/constants";
import { Field } from "./_shared/Field";
import { IconTrash } from "./_shared/icons";
import type { InspectorVoice } from "./_shared/types";
import { loadVoicesCached } from "./_shared/voicesCache";

// ── Right-side inspector for the selected node ───────────────────────────
//
// Surfaces every field the ElevenLabs workflow node schema exposes, keyed
// off our internal node.type:
//   - speak     → maps to override_agent: additional_prompt + voice/llm/kb/tool overrides
//   - collect   → override_agent + a `collect_field` data key
//   - condition → override_agent acting as router; surfaces `expression`
//   - tool_call → dispatch_tool: tool_id (dropdown of agent's tools) + instruction
//   - transfer  → transfer_to_number (phone_number) OR agent_transfer
//                 (target_agent_id) — picker selects mode
//   - start/end → no editable fields
//
// Plus a read-only "Connections" section listing outgoing edges with their
// label + condition + target. Saves a single PATCH body { label?, data? }
// and replays the response patch into the store.
export function NodeInspector({
  agentId,
  node,
  outgoingEdges,
  allNodes,
  onDelete,
  onClose,
}: {
  agentId: string;
  node: WorkflowNode | null;
  outgoingEdges: WorkflowEdge[];
  allNodes: WorkflowNode[];
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const availableTools = useAgentStore((s) => s.config?.tools ?? []);

  // Snapshot the incoming data so we can dirty-check + reset on node change.
  const initialLabel = node?.label ?? "";
  const initialData = useMemo(
    () => JSON.stringify(node?.data ?? {}),
    [node?.id],
    // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [label, setLabel] = useState(initialLabel);
  const [data, setData] = useState<Record<string, unknown>>(
    () => ({ ...(node?.data ?? {}) }),
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const canDelete = node?.id !== "start";

  const handleDelete = async () => {
    if (!canDelete || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  // Reset when the selected node id changes.
  useEffect(() => {
    setLabel(node?.label ?? "");
    setData({ ...(node?.data ?? {}) });
    setError(null);
    setShowAdvanced(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id]);

  // Lazy-load the voice list once per session for the override dropdown.
  const [voices, setVoices] = useState<InspectorVoice[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadVoicesCached()
      .then((vs) => {
        if (!cancelled) setVoices(vs);
      })
      .catch((e) => {
        if (!cancelled) {
          setVoicesError(e instanceof Error ? e.message : "load failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!node) return null;

  const dirty =
    label !== initialLabel || JSON.stringify(data) !== initialData;

  const setField = (key: string, value: unknown) =>
    setData((d) => {
      const next = { ...d };
      if (value === "" || value === undefined || value === null) delete next[key];
      else next[key] = value;
      return next;
    });

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: { label?: string; data?: Record<string, unknown> } = {};
      if (label !== initialLabel) body.label = label;
      if (JSON.stringify(data) !== initialData) body.data = data;
      const res = await appFetch(
        `/api/agents/${agentId}/workflow/${node.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(errBody?.error ?? `Save failed (${res.status})`);
      }
      const json = (await res.json()) as {
        revision: number;
        patch: Partial<AgentConfigCache>;
      };
      applyConfigDirect(json.patch, json.revision);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const nodeById = (id: string) =>
    allNodes.find((n) => n.id === id) ?? null;

  // Render the type-specific main field(s).
  const renderTypeFields = () => {
    switch (node.type) {
      case "speak":
        return (
          <Field
            label="What the agent should say"
            hint="Free-text instruction the agent follows when it reaches this node. Used as additional_prompt on the override_agent node."
          >
            <textarea
              dir="auto"
              value={(data.prompt as string) ?? ""}
              onChange={(e) => setField("prompt", e.target.value)}
              className="vb-field-input vb-field-textarea"
              rows={6}
              placeholder="e.g. Greet the caller warmly and ask how you can help."
            />
          </Field>
        );

      case "collect":
        return (
          <>
            <Field
              label="What to collect"
              hint="The single piece of information this node should gather (used as a dynamic variable name in the conversation)."
            >
              <input
                dir="auto"
                value={(data.collect_field as string) ?? ""}
                onChange={(e) => setField("collect_field", e.target.value)}
                className="vb-field-input"
                placeholder="e.g. caller_email"
              />
            </Field>
            <Field
              label="How to ask"
              hint="Instruction the agent follows while gathering this info."
            >
              <textarea
                dir="auto"
                value={(data.prompt as string) ?? ""}
                onChange={(e) => setField("prompt", e.target.value)}
                className="vb-field-input vb-field-textarea"
                rows={5}
                placeholder="e.g. Ask the caller for their email so we can follow up."
              />
            </Field>
          </>
        );

      case "condition":
        return (
          <>
            <Field
              label="Routing expression"
              hint="Variable name or short logical expression. The outgoing edges' conditions are evaluated against this."
            >
              <input
                dir="auto"
                value={(data.expression as string) ?? ""}
                onChange={(e) => setField("expression", e.target.value)}
                className="vb-field-input"
                placeholder="e.g. issue_category"
              />
            </Field>
            <Field
              label="Router instructions"
              hint="Optional guidance the LLM uses when deciding which branch to take."
            >
              <textarea
                dir="auto"
                value={(data.prompt as string) ?? ""}
                onChange={(e) => setField("prompt", e.target.value)}
                className="vb-field-input vb-field-textarea"
                rows={4}
                placeholder="Decide which branch best matches the caller's intent."
              />
            </Field>
          </>
        );

      case "tool_call":
        return (
          <>
            <Field
              label="Tool"
              hint="Which webhook/client tool this node will dispatch. Maps to dispatch_tool.tool_id."
            >
              <select
                value={(data.tool_id as string) ?? ""}
                onChange={(e) => setField("tool_id", e.target.value)}
                className="vb-field-input"
              >
                <option value="">— pick a tool —</option>
                {availableTools.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.provider ? ` · ${t.provider}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Instruction"
              hint="Optional natural-language instruction telling the agent how to use the tool here."
            >
              <textarea
                dir="auto"
                value={(data.instruction as string) ?? ""}
                onChange={(e) => setField("instruction", e.target.value)}
                className="vb-field-input vb-field-textarea"
                rows={5}
                placeholder="e.g. Look up the caller in the CRM using their email."
              />
            </Field>
          </>
        );

      case "transfer": {
        const mode: "number" | "agent" =
          (data.phone_number as string | undefined)?.length
            ? "number"
            : (data.target_agent_id as string | undefined)?.length
              ? "agent"
              : "number";
        return (
          <>
            <Field label="Transfer to">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setField("target_agent_id", undefined);
                    setField("phone_number", data.phone_number ?? "");
                  }}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-xs ${
                    mode === "number"
                      ? "border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)"
                      : "border-(--color-border) text-(--color-muted)"
                  }`}
                >
                  Phone number
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setField("phone_number", undefined);
                    setField("target_agent_id", data.target_agent_id ?? "");
                  }}
                  className={`flex-1 rounded-md border px-3 py-1.5 text-xs ${
                    mode === "agent"
                      ? "border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)"
                      : "border-(--color-border) text-(--color-muted)"
                  }`}
                >
                  Another agent
                </button>
              </div>
            </Field>
            {mode === "number" ? (
              <Field
                label="Phone number"
                hint="E.164 format. Maps to transfer_to_number.phone_number."
              >
                <input
                  value={(data.phone_number as string) ?? ""}
                  onChange={(e) => setField("phone_number", e.target.value)}
                  className="vb-field-input"
                  placeholder="+1555…"
                />
              </Field>
            ) : (
              <Field
                label="Target agent id"
                hint="ElevenLabs agent_id to hand off to. Maps to agent_transfer.target_agent_id."
              >
                <input
                  value={(data.target_agent_id as string) ?? ""}
                  onChange={(e) => setField("target_agent_id", e.target.value)}
                  className="vb-field-input font-mono"
                  placeholder="agent_…"
                />
              </Field>
            )}
            <Field
              label="Transfer reason (optional)"
              hint="Optional instruction the agent reads before transferring."
            >
              <textarea
                dir="auto"
                value={(data.instruction as string) ?? ""}
                onChange={(e) => setField("instruction", e.target.value)}
                className="vb-field-input vb-field-textarea"
                rows={3}
                placeholder="e.g. Let the caller know we're transferring them to billing."
              />
            </Field>
          </>
        );
      }

      case "start":
      case "end":
      default:
        return (
          <p className="vb-field-hint">
            This node is a control point in the graph — no editable fields.
          </p>
        );
    }
  };

  // Advanced overrides — only relevant for override_agent-class nodes.
  const supportsOverrides =
    node.type === "speak" ||
    node.type === "collect" ||
    node.type === "condition";

  return (
    <aside className="vb-el-inspector">
      <header className="vb-el-inspector-head">
        <span className={`vb-el-icon vb-el-icon-${node.type}`} aria-hidden>
          {ICON[node.type]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-mono uppercase tracking-widest text-(--color-muted-soft)">
            {node.type} · {node.id}
          </div>
          <div className="truncate text-[13px] font-semibold text-(--color-foreground-strong)">
            {node.label || "(untitled)"}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
        >
          ✕
        </button>
      </header>

      <div className="vb-el-inspector-body">
        <Field label="Title">
          <input
            dir="auto"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="vb-field-input"
            placeholder="Node title"
          />
        </Field>

        {renderTypeFields()}

        {supportsOverrides && (
          <details
            open={showAdvanced}
            onToggle={(e) => setShowAdvanced(e.currentTarget.open)}
            className="rounded-md border border-(--color-border) bg-(--color-panel-soft)/40"
          >
            <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
              Advanced overrides
            </summary>
            <div className="space-y-3 px-3 pb-3">
              <Field
                label="System prompt override"
                hint="Replaces the agent's global system prompt while at this node."
              >
                <textarea
                  dir="auto"
                  value={(data.system_prompt_override as string) ?? ""}
                  onChange={(e) =>
                    setField("system_prompt_override", e.target.value)
                  }
                  className="vb-field-input vb-field-textarea"
                  rows={4}
                />
              </Field>
              <Field
                label="Voice override"
                hint="Overrides the agent's default voice while this node is active. Leave on 'Use agent default' to inherit."
              >
                {voicesError && (
                  <p
                    className="vb-field-hint"
                    style={{ color: "var(--color-danger)" }}
                  >
                    Voice list error: {voicesError}
                  </p>
                )}
                {(() => {
                  const currentVoiceId =
                    typeof data.voice_id === "string" ? data.voice_id : "";
                  const orphanVoiceId =
                    currentVoiceId &&
                    !voices.some((v) => v.voice_id === currentVoiceId)
                      ? currentVoiceId
                      : "";
                  return (
                    <select
                      value={currentVoiceId}
                      onChange={(e) =>
                        setField("voice_id", e.target.value || undefined)
                      }
                      className="vb-field-input font-medium"
                    >
                      <option value="">Use agent default</option>
                      {/* Keep an entry for an unknown id so a saved
                          override still selects correctly even before the
                          voice list loads or if the voice was deleted
                          upstream. */}
                      {orphanVoiceId && (
                        <option value={orphanVoiceId}>{orphanVoiceId}</option>
                      )}
                      {voices.map((v) => {
                        const accent = v.labels?.accent;
                        const gender = v.labels?.gender;
                        const cat = v.category ?? "premade";
                        const meta = [cat, gender, accent]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <option key={v.voice_id} value={v.voice_id}>
                            {v.name}
                            {meta ? `  —  ${meta}` : ""}
                          </option>
                        );
                      })}
                    </select>
                  );
                })()}
              </Field>
            </div>
          </details>
        )}

        <div className="rounded-md border border-(--color-border)">
          <div className="border-b border-(--color-border) px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
            Connections ({outgoingEdges.length})
          </div>
          {outgoingEdges.length === 0 ? (
            <p className="px-3 py-3 text-xs text-(--color-muted)">
              This node has no outgoing edges yet.
            </p>
          ) : (
            <ul className="divide-y divide-(--color-border)">
              {outgoingEdges.map((e) => {
                const target = nodeById(e.to);
                return (
                  <li key={e.id} className="px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-(--color-muted)">→</span>
                      <span className="font-medium text-(--color-foreground-strong)">
                        {target?.label ?? e.to}
                      </span>
                      <span className="font-mono text-[10px] text-(--color-muted-soft)">
                        {target?.type ?? "?"}
                      </span>
                    </div>
                    {(e.label || e.condition) && (
                      <div className="mt-1 text-[11px] text-(--color-muted)">
                        {e.label && (
                          <span className="mr-2 inline-flex items-center gap-1">
                            <span aria-hidden>↳</span>
                            {e.label}
                          </span>
                        )}
                        {e.condition && (
                          <span className="font-mono text-(--color-accent)">
                            when: {e.condition}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {error && (
          <p className="vb-field-hint" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}
      </div>

      <footer className="vb-el-inspector-foot">
        {canDelete && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={saving || deleting}
            className="mr-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-(--color-danger) transition hover:bg-(--color-danger)/10 disabled:opacity-60"
          >
            <IconTrash />
            {deleting ? "Deleting…" : "Delete node"}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          disabled={saving || deleting}
          className="rounded-md px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground-strong)"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving || deleting}
          className="rounded-md bg-(--color-foreground-strong) px-3 py-1.5 text-xs font-semibold text-white disabled:bg-(--color-border-strong) disabled:text-(--color-muted-soft)"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </aside>
  );
}
