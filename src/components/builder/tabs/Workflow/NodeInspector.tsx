import { useEffect, useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type {
  AgentConfigCache,
  WorkflowEdge,
  WorkflowNode,
} from "@/types/agent";
import { ICON, nodeDisplayLabel } from "./_shared/constants";
import { Field } from "./_shared/Field";
import { EdgeConditionEditor } from "./EdgeConditionEditor";
import { IconTrash } from "./_shared/icons";
import type { InspectorVoice } from "./_shared/types";
import { loadVoicesCached } from "./_shared/voicesCache";
import {
  loadProviderIconsCached,
  type ProviderIconInfo,
} from "./_shared/providerIconsCache";
import { ProviderIcon } from "../Tools/primitives/ProviderIcon";

// ── Right-side inspector for the selected node ───────────────────────────
//
// Surfaces every field the ElevenLabs workflow node schema exposes, keyed
// off our internal node.type:
//   - speak        → override_agent: additional_prompt (+ advanced overrides)
//   - say          → say: a structured message (literal text | LLM prompt),
//                    plus the same advanced overrides as override_agent
//   - update_state → update_state: variable assignments (updates[])
//   - tool_call    → tool: tools[].tool_id (dropdown of agent's tools)
//   - transfer     → phone_number (data.phone_number → transfer_destination)
//                    OR standalone_agent (data.agent_id) — picker selects mode
//   - start/end    → no editable fields
//
// Saves a single PATCH body { label?, data? } and replays the response patch
// into the store. Outgoing connections aren't shown here — the user reads them
// off the workflow canvas.
export function NodeInspector({
  agentId,
  node,
  incomingEdges,
  focusedEdgeId,
  allNodes,
  onDelete,
  onClose,
}: {
  agentId: string;
  node: WorkflowNode | null;
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
  // Pre-fill the title with the friendly default ("Tool node", …) when the
  // node only carries a raw id label — both this snapshot and the input
  // state use it, so the field reads nicely without becoming dirty on open.
  const initialLabel = node ? nodeDisplayLabel(node) : "";
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
  // provider id → { icon, name }, used to show each tool's integration logo.
  const [providerIcons, setProviderIcons] = useState<
    Map<string, ProviderIconInfo>
  >(() => new Map());

  // Edge-condition editing happens in a dedicated panel (EdgeConditionEditor)
  // when the user clicks an edge pill on the canvas. Direct node clicks never
  // surface edge controls.
  const incomingEdge = focusedEdgeId
    ? incomingEdges.find((e) => e.id === focusedEdgeId) ?? null
    : null;

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
    setLabel(node ? nodeDisplayLabel(node) : "");
    setData({ ...(node?.data ?? {}) });
    setError(null);
    setShowAdvanced(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id]);

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

  // Lazy-load the provider catalog once so each tool row can show its
  // integration icon (HubSpot, Slack, Google, …) instead of a text badge.
  useEffect(() => {
    let cancelled = false;
    loadProviderIconsCached(agentId)
      .then((m) => {
        if (!cancelled) setProviderIcons(m);
      })
      .catch(() => {
        /* non-fatal — tool rows just render without their provider logo */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

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
      // Save the node's label / data. Edge conditions are edited separately
      // via the EdgeConditionEditor (pill click).
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
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Render the type-specific main field(s).
  const renderTypeFields = () => {
    switch (node.type) {
      case "speak":
        return (
          <Field
            label="What this step should do"
            hint="Goal/instruction the agent follows while this node is active. Serialized as additional_prompt on the override_agent node. Branching happens on the outgoing edges."
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

      case "say": {
        const messageType =
          data.message_type === "prompt" ? "prompt" : "literal";
        const modeBtnClass = (active: boolean) =>
          `flex-1 rounded-md border px-2 py-1.5 text-xs ${
            active
              ? "border-(--color-accent) bg-(--color-accent)/10 text-(--color-accent)"
              : "border-(--color-border) text-(--color-muted)"
          }`;
        return (
          <>
            <Field label="Message">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setField("message_type", "literal")}
                  className={modeBtnClass(messageType === "literal")}
                >
                  Spoken text
                </button>
                <button
                  type="button"
                  onClick={() => setField("message_type", "prompt")}
                  className={modeBtnClass(messageType === "prompt")}
                >
                  LLM prompt
                </button>
              </div>
            </Field>
            {messageType === "literal" ? (
              <Field
                label="Text to speak"
                hint="The exact line the agent speaks. Serialized as message { type: literal, text }."
              >
                <textarea
                  dir="auto"
                  value={(data.message_text as string) ?? ""}
                  onChange={(e) => setField("message_text", e.target.value)}
                  className="vb-field-input vb-field-textarea"
                  rows={5}
                  placeholder="e.g. Thanks for calling — one moment while I pull that up."
                />
              </Field>
            ) : (
              <Field
                label="Prompt"
                hint="Instruction the LLM uses to generate the line. Serialized as message { type: prompt, prompt }."
              >
                <textarea
                  dir="auto"
                  value={(data.message_prompt as string) ?? ""}
                  onChange={(e) => setField("message_prompt", e.target.value)}
                  className="vb-field-input vb-field-textarea"
                  rows={5}
                  placeholder="e.g. Confirm the caller's request back to them in one sentence."
                />
              </Field>
            )}
          </>
        );
      }

      case "update_state": {
        const updates = Array.isArray(data.updates)
          ? (data.updates as Array<Record<string, unknown>>)
          : [];
        // Read a single update's value as an editable string + a "kind" so the
        // common leaf expressions (text/number/boolean/variable) are editable.
        // Anything more complex (operator trees, llm) is preserved verbatim and
        // shown read-only so it round-trips unchanged.
        type Kind = "text" | "number" | "boolean" | "variable" | "complex";
        const readExpr = (
          expr: unknown,
        ): { kind: Kind; value: string } => {
          const e = expr as { type?: string; value?: unknown; name?: unknown };
          switch (e?.type) {
            case "string_literal":
              return { kind: "text", value: String(e.value ?? "") };
            case "number_literal":
              return { kind: "number", value: String(e.value ?? "") };
            case "boolean_literal":
              return { kind: "boolean", value: e.value ? "true" : "false" };
            case "dynamic_variable":
              return { kind: "variable", value: String(e.name ?? "") };
            default:
              return { kind: "complex", value: "" };
          }
        };
        const buildExpr = (kind: Kind, value: string): unknown => {
          switch (kind) {
            case "number":
              return { type: "number_literal", value: Number(value) || 0 };
            case "boolean":
              return { type: "boolean_literal", value: value === "true" };
            case "variable":
              return { type: "dynamic_variable", name: value };
            case "text":
            default:
              return { type: "string_literal", value };
          }
        };
        const writeUpdates = (next: typeof updates) =>
          setField("updates", next);
        const patchUpdate = (i: number, patch: Record<string, unknown>) =>
          writeUpdates(
            updates.map((u, idx) => (idx === i ? { ...u, ...patch } : u)),
          );
        return (
          <Field
            label="Variable assignments"
            hint="Each row sets a conversation-state variable. Reference these later with {{variable_name}} or in edge expressions."
          >
            <div className="space-y-2">
              {updates.length === 0 && (
                <p className="rounded-md border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-xs text-(--color-muted)">
                  No assignments yet.
                </p>
              )}
              {updates.map((u, i) => {
                const { kind, value } = readExpr(u.expression);
                return (
                  <div
                    key={i}
                    className="space-y-1.5 rounded-md border border-(--color-border) p-2"
                  >
                    <div className="flex gap-1.5">
                      <input
                        dir="auto"
                        value={(u.variable_name as string) ?? ""}
                        onChange={(e) =>
                          patchUpdate(i, { variable_name: e.target.value })
                        }
                        className="vb-field-input flex-1"
                        placeholder="variable_name"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          writeUpdates(updates.filter((_, idx) => idx !== i))
                        }
                        aria-label="Remove assignment"
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-red-500"
                      >
                        ✕
                      </button>
                    </div>
                    {kind === "complex" ? (
                      <p className="px-1 text-[11px] text-(--color-muted)">
                        Complex expression — edit in the ElevenLabs editor.
                      </p>
                    ) : (
                      <div className="flex gap-1.5">
                        <select
                          value={kind}
                          onChange={(e) =>
                            patchUpdate(i, {
                              expression: buildExpr(
                                e.target.value as Kind,
                                "",
                              ),
                            })
                          }
                          className="vb-field-input w-28 shrink-0"
                        >
                          <option value="text">Text</option>
                          <option value="number">Number</option>
                          <option value="boolean">Boolean</option>
                          <option value="variable">Variable</option>
                        </select>
                        {kind === "boolean" ? (
                          <select
                            value={value}
                            onChange={(e) =>
                              patchUpdate(i, {
                                expression: buildExpr("boolean", e.target.value),
                              })
                            }
                            className="vb-field-input flex-1"
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <input
                            dir="auto"
                            type={kind === "number" ? "number" : "text"}
                            value={value}
                            onChange={(e) =>
                              patchUpdate(i, {
                                expression: buildExpr(kind, e.target.value),
                              })
                            }
                            className="vb-field-input flex-1"
                            placeholder={
                              kind === "variable" ? "source_variable" : "value"
                            }
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() =>
                  writeUpdates([
                    ...updates,
                    {
                      variable_name: "",
                      expression: { type: "string_literal", value: "" },
                    },
                  ])
                }
                className="rounded-md border border-(--color-border) px-2.5 py-1.5 text-xs text-(--color-muted) hover:bg-(--color-panel-soft)"
              >
                + Add assignment
              </button>
            </div>
          </Field>
        );
      }

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
            <Field label={selectedIds.length > 1 ? "Tools (parallel)" : "Tool"}>
              {inCallTools.length === 0 && staleIds.length === 0 ? (
                <p className="rounded-md border border-dashed border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-xs text-(--color-muted)">
                  No in-call tools attached to this agent yet. Install one
                  from the Tools tab.
                </p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-1 overflow-auto rounded-md border border-(--color-border) bg-white p-2">
                  {inCallTools.map((t) => {
                    const isOn = selectedIds.includes(t.id);
                    // A tool node always keeps at least one tool. Clicking the
                    // sole selected tool is a no-op — removal is "delete node".
                    const isLastSelected = isOn && selectedIds.length === 1;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => {
                            if (isLastSelected) return;
                            toggleId(t.id);
                          }}
                          aria-pressed={isOn}
                          className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition ${
                            isOn
                              ? "border-(--color-border-strong) bg-(--color-panel-soft)"
                              : "cursor-pointer border-transparent hover:bg-(--color-panel-soft)"
                          } ${isLastSelected ? "cursor-default" : "cursor-pointer"}`}
                        >
                          {t.provider && providerIcons.has(t.provider) && (
                            <span className="mt-0.5 shrink-0">
                              <ProviderIcon
                                icon={providerIcons.get(t.provider)!.icon}
                                name={providerIcons.get(t.provider)!.name}
                              />
                            </span>
                          )}
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="font-medium text-(--color-foreground-strong)">
                              {t.name}
                            </span>
                            {t.description && (
                              <span className="line-clamp-2 text-[11px] text-(--color-muted)">
                                {t.description}
                              </span>
                            )}
                          </span>
                          {isOn && (
                            <span
                              className="mt-0.5 shrink-0 text-(--color-foreground-strong)"
                              aria-hidden
                            >
                              ✓
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                  {staleIds.map((id) => (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => toggleId(id)}
                        className="flex w-full cursor-pointer items-start gap-2 rounded-md border border-red-400/30 bg-red-500/5 px-2 py-1.5 text-left text-xs"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="font-mono text-[11px] text-red-600">
                            {id}
                          </span>
                          <span className="text-[10px] text-red-500">
                            Unbound — click to remove the dead reference.
                          </span>
                        </span>
                        <span
                          className="mt-0.5 shrink-0 text-red-500"
                          aria-hidden
                        >
                          ✕
                        </span>
                      </button>
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

  // Advanced overrides — only relevant for override_agent-class nodes
  // (speak/Subagent and say both carry the override_agent override fields).
  const supportsOverrides = node.type === "speak" || node.type === "say";

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
      <EdgeConditionEditor
        agentId={agentId}
        edge={incomingEdge}
        parentLabel={parentLabel}
        targetLabel={targetLabel}
        onClose={onClose}
      />
    );
  }

  return (
    <aside className="vb-el-inspector">
      <header className="vb-el-inspector-head">
        <span className={`vb-el-icon vb-el-icon-${node.type}`} aria-hidden>
          {ICON[node.type]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-(--color-foreground-strong)">
            {nodeDisplayLabel(node)}
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
                              {t.provider && providerIcons.has(t.provider) && (
                                <span className="mt-0.5 shrink-0">
                                  <ProviderIcon
                                    icon={providerIcons.get(t.provider)!.icon}
                                    name={providerIcons.get(t.provider)!.name}
                                  />
                                </span>
                              )}
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="font-medium text-(--color-foreground-strong)">
                                  {t.name}
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
