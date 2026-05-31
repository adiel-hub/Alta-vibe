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
//   - speak     → maps to override_agent: additional_prompt
//   - collect   → override_agent + a `collect_field` data key
//   - condition → override_agent acting as router; surfaces `expression`
//   - tool_call → tool: tools[].tool_id (dropdown of agent's tools)
//   - transfer  → phone_number (data.phone_number → transfer_destination)
//                 OR standalone_agent (data.agent_id) — picker selects mode
//   - start/end → no editable fields
//
// Plus a read-only "Connections" section listing outgoing edges with their
// label + condition + target. Saves a single PATCH body { label?, data? }
// and replays the response patch into the store.
export function NodeInspector({
  agentId,
  node,
  outgoingEdges,
  incomingEdges,
  focusedEdgeId,
  allNodes,
  onDelete,
  onClose,
}: {
  agentId: string;
  node: WorkflowNode | null;
  outgoingEdges: WorkflowEdge[];
  /** Edges that point AT this node. For tool_call nodes we auto-surface the
   *  single incoming edge's `forward_condition` as the tool's "entry
   *  condition" — the user thinks of it as "when does this tool fire?",
   *  which is more natural than hunting for the edge to edit it on. */
  incomingEdges: WorkflowEdge[];
  /** When set, the inspector renders the condition editor for THIS edge
   *  (an entry to the current node) regardless of node type. Wired up by
   *  the canvas when the user clicks an edge pill — same UI as the
   *  tool_call entry-condition editor, but available for any target. */
  focusedEdgeId?: string | null;
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
  const [voices, setVoices] = useState<InspectorVoice[]>([]);

  // Edge-condition editor only renders when the user reached this panel
  // by clicking an edge pill on the canvas. Direct node clicks never
  // surface edge controls — edges are edited from the dedicated edge
  // mode (see early return below). Storage stays on the edge; saves
  // PATCH /workflow/edges/[edgeId].
  const incomingEdge = focusedEdgeId
    ? incomingEdges.find((e) => e.id === focusedEdgeId) ?? null
    : null;
  const initialEntryFc = incomingEdge?.forward_condition;
  const initialEntryType: "unconditional" | "llm" | "result" =
    initialEntryFc?.type === "llm"
      ? "llm"
      : initialEntryFc?.type === "result"
        ? "result"
        : "unconditional";
  const initialEntryCondition =
    initialEntryFc?.type === "llm" ? initialEntryFc.condition : "";
  const initialEntrySuccessful =
    initialEntryFc?.type === "result" ? initialEntryFc.successful : true;
  // Edge pill text. Priority on read matches the canvas: explicit
  // condition.label first, then the edge's legacy root label.
  const initialEntryLabel =
    initialEntryFc?.label ?? incomingEdge?.label ?? "";
  const [entryType, setEntryType] = useState<
    "unconditional" | "llm" | "result"
  >(initialEntryType);
  const [entryCondition, setEntryCondition] = useState(initialEntryCondition);
  const [entrySuccessful, setEntrySuccessful] = useState(initialEntrySuccessful);
  const [entryLabel, setEntryLabel] = useState(initialEntryLabel);
  const PILL_MAX_CHARS = 50;

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

  // Reset entry-condition state when the FOCUSED edge changes — covers
  // clicking a different pill while staying on the same target node, and
  // also re-initializes when the node itself changes (since incomingEdge
  // becomes a different object).
  useEffect(() => {
    setEntryType(initialEntryType);
    setEntryCondition(initialEntryCondition);
    setEntrySuccessful(initialEntrySuccessful);
    setEntryLabel(initialEntryLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingEdge?.id]);

  // Lazy-load voice list once per session for the override dropdown.
  useEffect(() => {
    let cancelled = false;
    loadVoicesCached()
      .then((vs) => {
        if (!cancelled) setVoices(vs);
      })
      .catch(() => {
        /* non-fatal — the override section just shows fewer options */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!node) return null;

  const entryDirty =
    !!incomingEdge &&
    (entryType !== initialEntryType ||
      (entryType === "llm" && entryCondition !== initialEntryCondition) ||
      (entryType === "result" && entrySuccessful !== initialEntrySuccessful) ||
      entryLabel.trim() !== initialEntryLabel.trim());
  const dirty =
    label !== initialLabel ||
    JSON.stringify(data) !== initialData ||
    entryDirty;
  const entryConditionInvalid =
    entryType === "llm" && entryCondition.trim().length === 0;

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
    if (entryConditionInvalid) {
      setError("Entry condition cannot be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Save the node first (label / data). For tool_call nodes whose
      // entry condition was edited, follow up with the edge PATCH —
      // we do these sequentially so the second call sees the latest
      // revision and the panel ends with one applied state_patch.
      const nodeBody: { label?: string; data?: Record<string, unknown> } = {};
      if (label !== initialLabel) nodeBody.label = label;
      if (JSON.stringify(data) !== initialData) nodeBody.data = data;
      if (nodeBody.label !== undefined || nodeBody.data !== undefined) {
        const res = await appFetch(
          `/api/agents/${agentId}/workflow/${node.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(nodeBody),
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
      }
      if (entryDirty && incomingEdge) {
        const trimmedLabel = entryLabel.trim();
        const labelField = trimmedLabel.length > 0 ? trimmedLabel : undefined;
        const forwardCondition =
          entryType === "unconditional"
            ? {
                type: "unconditional" as const,
                ...(labelField ? { label: labelField } : {}),
              }
            : entryType === "llm"
              ? {
                  type: "llm" as const,
                  condition: entryCondition.trim(),
                  ...(labelField ? { label: labelField } : {}),
                }
              : {
                  type: "result" as const,
                  successful: entrySuccessful,
                  ...(labelField ? { label: labelField } : {}),
                };
        const res = await appFetch(
          `/api/agents/${agentId}/workflow/edges/${incomingEdge.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              forward_condition: forwardCondition,
              // Also clear the legacy edge-root label so the pill only
              // reads from the structured condition's label going forward.
              label: labelField ?? null,
            }),
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
      }
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

      case "tool_call": {
        // Build the canonical set of selected ids from BOTH legacy
        // single-tool (`tool_id`) and parallel-tools (`tool_ids[]`).
        // Saves always write back to `tool_ids` (the array form); the
        // serializer accepts either shape, so this keeps cached agents
        // authored before parallel-tools support reading correctly.
        const rawIds = Array.isArray(data.tool_ids)
          ? (data.tool_ids as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
          : [];
        const legacySingle =
          typeof data.tool_id === "string" ? (data.tool_id as string) : "";
        const selectedIds: string[] = [];
        for (const id of [...rawIds, legacySingle]) {
          if (id && !selectedIds.includes(id)) selectedIds.push(id);
        }
        const inCallTools = availableTools.filter((t) => t.phase === "in_call");
        const knownIds = new Set(inCallTools.map((t) => t.id));
        const staleIds = selectedIds.filter((id) => !knownIds.has(id));
        const writeBack = (next: string[]) => {
          setField("tool_ids", next.length > 0 ? next : undefined);
          // Keep the legacy singular slot in sync with the first entry so
          // any reader that still looks at `tool_id` (the workflow panel
          // node card, older serializers) keeps working.
          setField("tool_id", next[0] ?? undefined);
        };
        const toggleId = (id: string) => {
          const next = selectedIds.includes(id)
            ? selectedIds.filter((x) => x !== id)
            : [...selectedIds, id];
          writeBack(next);
        };
        return (
          <>
            <Field
              label={selectedIds.length > 1 ? "Tools (parallel)" : "Tool"}
              hint={
                "Tools this node dispatches. Pick one for a single dispatch, or check several to fire them in parallel — the node succeeds only if ALL selected tools succeed."
              }
            >
              {inCallTools.length === 0 && staleIds.length === 0 ? (
                <p className="rounded-md border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-xs text-(--color-muted)">
                  No in-call tools attached to this agent yet. Install one
                  from the Tools tab.
                </p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-1 overflow-auto rounded-md border border-(--color-border) bg-white p-2">
                  {inCallTools.map((t) => {
                    const isOn = selectedIds.includes(t.id);
                    return (
                      <li key={t.id}>
                        <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-(--color-panel-soft)">
                          <input
                            type="checkbox"
                            checked={isOn}
                            onChange={() => toggleId(t.id)}
                            className="mt-0.5"
                          />
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="flex items-center gap-1.5">
                              <span className="font-medium text-(--color-foreground-strong)">
                                {t.name}
                              </span>
                              {t.provider && (
                                <span className="rounded bg-(--color-accent)/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-(--color-accent)">
                                  {t.provider}
                                </span>
                              )}
                            </span>
                            {t.description && (
                              <span className="line-clamp-2 text-[11px] text-(--color-muted)">
                                {t.description}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                  {staleIds.map((id) => (
                    <li key={id}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-red-400/30 bg-red-500/5 px-2 py-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked
                          onChange={() => toggleId(id)}
                          className="mt-0.5"
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="font-mono text-[11px] text-red-600">
                            {id}
                          </span>
                          <span className="text-[10px] text-red-500">
                            Unbound — uncheck to remove the dead reference.
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {selectedIds.length > 1 && (
                <p className="mt-1 text-[11px] text-(--color-muted)">
                  Parallel: {selectedIds.length} tools fire together; the
                  node only succeeds if all of them do.
                </p>
              )}
            </Field>

            {/* Wiring hint when the tool isn't connected yet. Edge
                conditions are edited from the canvas — click an edge
                label to open its dedicated editor. */}
            {incomingEdges.length === 0 && (
              <p className="rounded-md border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-xs text-(--color-muted)">
                No incoming edges yet — connect a parent node so the
                workflow can reach this tool.
              </p>
            )}
            {incomingEdges.length >= 1 && (
              <p className="rounded-md border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-[11px] text-(--color-muted)">
                Click an edge label on the canvas to edit when this tool
                fires.
              </p>
            )}
          </>
        );
      }

      case "transfer": {
        // Read both keys for back-compat with agents whose cache still
        // carries the legacy `target_agent_id`. Saves always use `agent_id`.
        const agentIdValue =
          (data.agent_id as string | undefined) ??
          (data.target_agent_id as string | undefined) ??
          "";
        const sipValue = (data.sip_uri as string | undefined) ?? "";
        const phoneValue = (data.phone_number as string | undefined) ?? "";
        // Three mutually-exclusive destinations: phone, SIP URI, agent.
        // sip_uri wins when both phone+sip are present (the serializer
        // does too, so the UI agrees with what actually ships).
        const mode: "phone" | "sip" | "agent" = sipValue.length
          ? "sip"
          : phoneValue.length
            ? "phone"
            : agentIdValue.length
              ? "agent"
              : "phone";
        const pickPhone = () => {
          setField("sip_uri", undefined);
          setField("agent_id", undefined);
          setField("target_agent_id", undefined);
          setField("phone_number", phoneValue);
        };
        const pickSip = () => {
          setField("phone_number", undefined);
          setField("agent_id", undefined);
          setField("target_agent_id", undefined);
          setField("sip_uri", sipValue);
        };
        const pickAgent = () => {
          setField("phone_number", undefined);
          setField("sip_uri", undefined);
          setField("target_agent_id", undefined);
          setField("agent_id", agentIdValue);
        };
        const modeBtnClass = (active: boolean) =>
          `flex-1 rounded-md border px-2 py-1.5 text-xs ${
            active
              ? "border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)"
              : "border-(--color-border) text-(--color-muted)"
          }`;
        return (
          <>
            <Field label="Transfer to">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={pickPhone}
                  className={modeBtnClass(mode === "phone")}
                >
                  Phone
                </button>
                <button
                  type="button"
                  onClick={pickSip}
                  className={modeBtnClass(mode === "sip")}
                >
                  SIP URI
                </button>
                <button
                  type="button"
                  onClick={pickAgent}
                  className={modeBtnClass(mode === "agent")}
                >
                  Agent
                </button>
              </div>
            </Field>
            {mode === "phone" ? (
              <>
                <Field
                  label="Phone number"
                  hint="E.164 number, or a dynamic variable like {{caller_number}}. Wrapped server-side into transfer_destination (phone | phone_dynamic_variable)."
                >
                  <input
                    value={phoneValue}
                    onChange={(e) => setField("phone_number", e.target.value)}
                    className="vb-field-input"
                    placeholder="+1555… or {{caller_number}}"
                  />
                </Field>
                <Field
                  label="Transfer type"
                  hint="conference = stay on the line; blind = drop after dial; sip_refer = SIP REFER handoff (provider-dependent)."
                >
                  <select
                    value={(data.transfer_type as string) ?? "conference"}
                    onChange={(e) => setField("transfer_type", e.target.value)}
                    className="vb-field-input"
                  >
                    <option value="conference">conference (default)</option>
                    <option value="blind">blind</option>
                    <option value="sip_refer">sip_refer</option>
                  </select>
                </Field>
                <Field
                  label="Post-dial digits"
                  hint="DTMF digits to send after connect. Use 'w' for a 0.5s pause (e.g. 'ww1234'). Twilio transfers only. Wrap in {{var}} to use a dynamic value."
                >
                  <input
                    value={(data.post_dial_digits as string) ?? ""}
                    onChange={(e) =>
                      setField("post_dial_digits", e.target.value)
                    }
                    className="vb-field-input font-mono"
                    placeholder="ww1234"
                  />
                </Field>
              </>
            ) : mode === "sip" ? (
              <>
                <Field
                  label="SIP URI"
                  hint="Full SIP URI (e.g. sip:alice@example.com). Wrap in {{var}} to resolve from a dynamic variable. Serialized as transfer_destination.sip_uri (or sip_uri_dynamic_variable)."
                >
                  <input
                    value={sipValue}
                    onChange={(e) => setField("sip_uri", e.target.value)}
                    className="vb-field-input font-mono"
                    placeholder="sip:alice@example.com or {{caller_sip}}"
                  />
                </Field>
                <Field
                  label="Transfer type"
                  hint="conference = stay on the line; blind = drop after dial; sip_refer = SIP REFER handoff."
                >
                  <select
                    value={(data.transfer_type as string) ?? "conference"}
                    onChange={(e) => setField("transfer_type", e.target.value)}
                    className="vb-field-input"
                  >
                    <option value="conference">conference (default)</option>
                    <option value="blind">blind</option>
                    <option value="sip_refer">sip_refer</option>
                  </select>
                </Field>
                <Field
                  label="Post-dial digits"
                  hint="DTMF digits to send after connect. Use 'w' for a 0.5s pause. Wrap in {{var}} for a dynamic value."
                >
                  <input
                    value={(data.post_dial_digits as string) ?? ""}
                    onChange={(e) =>
                      setField("post_dial_digits", e.target.value)
                    }
                    className="vb-field-input font-mono"
                    placeholder="ww1234"
                  />
                </Field>
              </>
            ) : (
              <>
                <Field
                  label="Target agent id"
                  hint="ElevenLabs agent_id to hand off to. Maps to standalone_agent.agent_id."
                >
                  <input
                    value={agentIdValue}
                    onChange={(e) => {
                      setField("agent_id", e.target.value);
                      setField("target_agent_id", undefined);
                    }}
                    className="vb-field-input font-mono"
                    placeholder="agent_…"
                  />
                </Field>
                <Field
                  label="Transfer message"
                  hint="Optional line the agent says to the caller right before the handoff."
                >
                  <textarea
                    dir="auto"
                    value={(data.transfer_message as string) ?? ""}
                    onChange={(e) =>
                      setField("transfer_message", e.target.value)
                    }
                    className="vb-field-input vb-field-textarea"
                    rows={3}
                    placeholder="Transferring you to our billing team — one moment…"
                  />
                </Field>
                <Field
                  label="Delay before transfer (ms)"
                  hint="Artificial wait before initiating the transfer. Leave blank for 0."
                >
                  <input
                    type="number"
                    min={0}
                    value={
                      typeof data.delay_ms === "number"
                        ? String(data.delay_ms)
                        : ""
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      setField(
                        "delay_ms",
                        v === "" ? undefined : Math.max(0, Number(v) || 0),
                      );
                    }}
                    className="vb-field-input"
                    placeholder="0"
                  />
                </Field>
                <label className="flex items-center gap-2 text-[12px] text-(--color-foreground-strong)">
                  <input
                    type="checkbox"
                    checked={
                      data.enable_transferred_agent_first_message === true
                    }
                    onChange={(e) =>
                      setField(
                        "enable_transferred_agent_first_message",
                        e.target.checked ? true : undefined,
                      )
                    }
                  />
                  <span>
                    Let the transferred agent send its own first message
                  </span>
                </label>
              </>
            )}
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

  // Edge-only mode: the user clicked an edge pill on the canvas. We render
  // a focused panel that ONLY shows the condition editor for that edge,
  // not the full node inspector. The auto-pick for tool_call (no
  // focusedEdgeId, single incoming edge) keeps the inline editor inside
  // the full inspector — only an explicit pill click flips into edge mode.
  const isEdgeMode = !!focusedEdgeId && !!incomingEdge;

  if (isEdgeMode && incomingEdge) {
    const parentNode = allNodes.find((n) => n.id === incomingEdge.from);
    const parentLabel = parentNode?.label ?? incomingEdge.from;
    const targetLabel = node.label || node.id;
    return (
      <aside className="vb-el-inspector">
        <header className="vb-el-inspector-head">
          <span className="vb-el-icon" aria-hidden>
            ⤷
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-(--color-muted-soft)">
              edge · {incomingEdge.id}
            </div>
            <div className="truncate text-[13px] font-semibold text-(--color-foreground-strong)">
              {parentLabel} → {targetLabel}
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
          <Field
            label="Label (pill text)"
            hint={`Short text that renders on the dark pill in the canvas — keep ≤${PILL_MAX_CHARS} chars. Leave empty to fall back to the condition body.`}
          >
            <input
              dir="auto"
              value={entryLabel}
              maxLength={PILL_MAX_CHARS}
              onChange={(e) => setEntryLabel(e.target.value)}
              className="vb-field-input"
              placeholder="e.g. wants billing"
            />
            <p className="mt-1 text-[10px] text-(--color-muted-soft)">
              {entryLabel.length}/{PILL_MAX_CHARS}
            </p>
          </Field>
          <Field
            label="Condition"
            hint={`Decides when the flow routes from “${parentLabel}” into “${targetLabel}”.`}
          >
            <select
              value={entryType}
              onChange={(e) =>
                setEntryType(
                  e.target.value as "unconditional" | "llm" | "result",
                )
              }
              className="vb-field-input"
            >
              <option value="llm">LLM Condition</option>
              <option value="unconditional">Unconditional</option>
              <option value="result">Tool result branch</option>
            </select>
            {entryType === "llm" && (
              <>
                <textarea
                  dir="auto"
                  value={entryCondition}
                  onChange={(e) => setEntryCondition(e.target.value)}
                  placeholder="e.g. the caller confirmed they want to open a support ticket"
                  rows={4}
                  className={`vb-field-input vb-field-textarea mt-2 ${
                    entryConditionInvalid
                      ? "border-red-400/60 ring-1 ring-red-400/40"
                      : ""
                  }`}
                />
                {entryConditionInvalid && (
                  <p className="mt-1 text-xs text-red-500">
                    Condition cannot be empty.
                  </p>
                )}
              </>
            )}
            {entryType === "result" && (
              <select
                value={entrySuccessful ? "successful" : "failed"}
                onChange={(e) =>
                  setEntrySuccessful(e.target.value === "successful")
                }
                className="vb-field-input mt-2"
              >
                <option value="successful">Parent tool succeeded</option>
                <option value="failed">Parent tool failed</option>
              </select>
            )}
            {entryType === "unconditional" && (
              <p className="mt-1 text-xs text-(--color-muted)">
                The flow always routes here next.
              </p>
            )}
          </Field>

          {error && (
            <p
              className="vb-field-hint"
              style={{ color: "var(--color-danger)" }}
            >
              {error}
            </p>
          )}
        </div>

        <footer className="vb-el-inspector-foot">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground-strong)"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!entryDirty || saving}
            className="rounded-md bg-(--color-foreground-strong) px-3 py-1.5 text-xs font-semibold text-white disabled:bg-(--color-border-strong) disabled:text-(--color-muted-soft)"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </aside>
    );
  }

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
                label="Voice override"
                hint="While this node is active, swap the agent's voice. Serialized as conversation_config.tts.voice_id."
              >
                {(() => {
                  const currentVoiceId =
                    typeof data.override_voice_id === "string"
                      ? data.override_voice_id
                      : "";
                  const orphanVoiceId =
                    currentVoiceId &&
                    !voices.some((v) => v.voice_id === currentVoiceId)
                      ? currentVoiceId
                      : "";
                  return (
                    <select
                      value={currentVoiceId}
                      onChange={(e) =>
                        setField(
                          "override_voice_id",
                          e.target.value || undefined,
                        )
                      }
                      className="vb-field-input font-medium"
                    >
                      <option value="">Use agent default</option>
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
              <Field
                label="LLM override"
                hint="Use a different model just for this node. Serialized as conversation_config.agent.prompt.llm."
              >
                <input
                  value={(data.override_llm as string) ?? ""}
                  onChange={(e) =>
                    setField("override_llm", e.target.value || undefined)
                  }
                  className="vb-field-input font-mono"
                  placeholder="e.g. gpt-4o-mini, claude-3-5-sonnet"
                />
              </Field>
              <Field
                label="Per-node first message"
                hint="Spoken when the agent enters this node. Serialized as conversation_config.agent.first_message."
              >
                <textarea
                  dir="auto"
                  value={(data.override_first_message as string) ?? ""}
                  onChange={(e) =>
                    setField(
                      "override_first_message",
                      e.target.value || undefined,
                    )
                  }
                  className="vb-field-input vb-field-textarea"
                  rows={3}
                />
              </Field>
              <Field
                label="Tools available at this node"
                hint="Tools the LLM can choose to call while this node is active (in addition to the global toolbox). Maps to additional_tool_ids[]."
              >
                {(() => {
                  const selected = new Set(
                    Array.isArray(data.additional_tool_ids)
                      ? (data.additional_tool_ids as string[])
                      : [],
                  );
                  const inCall = availableTools.filter(
                    (t) => t.phase === "in_call",
                  );
                  // Stale ids: selected entries that don't match any current
                  // binding. Show them with a "(unbound)" label so the user
                  // can uncheck them — invisible stale entries would silently
                  // fail workflow validation on save.
                  const knownIds = new Set(inCall.map((t) => t.id));
                  const staleIds = [...selected].filter(
                    (id) => !knownIds.has(id),
                  );
                  const toggle = (id: string) => {
                    const next = new Set(selected);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    const arr = [...next];
                    setField(
                      "additional_tool_ids",
                      arr.length > 0 ? arr : undefined,
                    );
                  };
                  if (inCall.length === 0 && staleIds.length === 0) {
                    return (
                      <p className="rounded-md border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-xs text-(--color-muted)">
                        No in-call tools attached to this agent yet. Install
                        one from the Tools tab to make it available here.
                      </p>
                    );
                  }
                  return (
                    <ul className="flex flex-col gap-1 rounded-md border border-(--color-border) bg-white p-2">
                      {inCall.map((t) => {
                        const isOn = selected.has(t.id);
                        return (
                          <li key={t.id}>
                            <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-(--color-panel-soft)">
                              <input
                                type="checkbox"
                                checked={isOn}
                                onChange={() => toggle(t.id)}
                                className="mt-0.5"
                              />
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex items-center gap-1.5">
                                  <span className="font-medium text-(--color-foreground-strong)">
                                    {t.name}
                                  </span>
                                  {t.provider && (
                                    <span className="rounded bg-(--color-accent)/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-(--color-accent)">
                                      {t.provider}
                                    </span>
                                  )}
                                </span>
                                {t.description && (
                                  <span className="line-clamp-2 text-[11px] text-(--color-muted)">
                                    {t.description}
                                  </span>
                                )}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                      {staleIds.map((id) => (
                        <li key={id}>
                          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-red-400/30 bg-red-500/5 px-2 py-1.5 text-xs">
                            <input
                              type="checkbox"
                              checked
                              onChange={() => toggle(id)}
                              className="mt-0.5"
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="font-mono text-[11px] text-red-600">
                                {id}
                              </span>
                              <span className="text-[10px] text-red-500">
                                Unbound — uncheck to remove the dead reference.
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
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
                const fc = e.forward_condition;
                const bc = e.backward_condition;
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
                    {(e.label || e.condition || fc) && (
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-(--color-muted)">
                        {e.label && (
                          <span className="inline-flex items-center gap-1">
                            <span aria-hidden>↳</span>
                            {e.label}
                          </span>
                        )}
                        {fc?.type === "llm" && (
                          <span className="font-mono text-(--color-accent)">
                            when: {fc.condition}
                          </span>
                        )}
                        {fc?.type === "expression" && (
                          <span className="font-mono text-(--color-accent)">
                            expr
                          </span>
                        )}
                        {fc?.type === "result" && (
                          <span
                            className="font-mono"
                            style={{
                              color: fc.successful
                                ? "var(--color-success, var(--color-accent))"
                                : "var(--color-danger)",
                            }}
                          >
                            on {fc.successful ? "success" : "failure"}
                          </span>
                        )}
                        {fc?.type === "unconditional" && !e.label && (
                          <span className="font-mono text-(--color-muted-soft)">
                            always
                          </span>
                        )}
                        {/* Legacy fallback: edges from before the structured
                            condition variants existed only carry e.condition. */}
                        {!fc && e.condition && (
                          <span className="font-mono text-(--color-accent)">
                            when: {e.condition}
                          </span>
                        )}
                      </div>
                    )}
                    {bc && (
                      <div className="mt-1 text-[11px] text-(--color-muted)">
                        <span aria-hidden>↩</span>{" "}
                        <span className="font-mono">
                          loops back ({bc.type}
                          {bc.type === "llm" ? `: ${bc.condition}` : ""}
                          {bc.type === "result"
                            ? `: ${bc.successful ? "success" : "failure"}`
                            : ""}
                          )
                        </span>
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
