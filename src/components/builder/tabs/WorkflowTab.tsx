"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type {
  AgentConfigCache,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "@/types/agent";

const NODE_W = 260;
const NODE_H = 96;
const COL_GAP = 32;
const ROW_GAP = 76;
const PADDING = 32;

/** Options offered in the "+" popup when adding a node below an existing one. */
const ADD_NODE_MENU: Array<{
  type: WorkflowNodeType;
  label: string;
  hint: string;
  defaultLabel: string;
}> = [
  { type: "speak", label: "Say", hint: "Agent speaks a line.", defaultLabel: "Speak" },
  { type: "collect", label: "Ask", hint: "Collect a field from the caller.", defaultLabel: "Collect" },
  { type: "condition", label: "Router", hint: "Branch on a variable or rule.", defaultLabel: "Route" },
  { type: "tool_call", label: "Tool", hint: "Run a runtime tool.", defaultLabel: "Tool call" },
  { type: "transfer", label: "Transfer", hint: "Hand off to another agent or number.", defaultLabel: "Transfer" },
  { type: "end", label: "End", hint: "End the call.", defaultLabel: "End call" },
];

/** Per-node glyph rendered inside the small circular badge on the card. */
const ICON: Record<WorkflowNodeType, string> = {
  start: "⚑",
  speak: "🙂",
  collect: "❓",
  condition: "⤳",
  tool_call: "🔧",
  transfer: "↪",
  end: "✕",
};

/**
 * BFS top-down layout: depth → row, sibling-in-depth → column.
 */
function layout(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) {
    if (byId.has(e.to)) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  const queue: string[] = [];
  const startNode = nodes.find((n) => n.id === "start");
  if (startNode) {
    depth.set(startNode.id, 0);
    queue.push(startNode.id);
  }
  for (const n of nodes) {
    if (n.id === startNode?.id) continue;
    if ((incoming.get(n.id) ?? 0) === 0 && !depth.has(n.id)) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const e of edges) {
      if (e.from !== id) continue;
      const cur = depth.get(e.to);
      if (cur === undefined || cur < d + 1) {
        depth.set(e.to, d + 1);
        queue.push(e.to);
      }
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  // Left-to-right: depth → column (x), sibling-in-depth → row (y).
  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const col = columns.get(d) ?? [];
    col.push(n.id);
    columns.set(d, col);
  }

  const tallest = Math.max(
    1,
    ...Array.from(columns.values()).map((arr) => arr.length),
  );
  const stageHeight = PADDING * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;

  const positions = new Map<string, { x: number; y: number }>();
  for (const [colIdx, ids] of columns) {
    const totalH = ids.length * NODE_H + (ids.length - 1) * ROW_GAP;
    const startY = (stageHeight - totalH) / 2;
    ids.forEach((id, sib) => {
      positions.set(id, {
        x: PADDING + colIdx * (NODE_W + COL_GAP),
        y: startY + sib * (NODE_H + ROW_GAP),
      });
    });
  }

  const maxCol = Math.max(0, ...Array.from(columns.keys()));
  const stageWidth = PADDING * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP;
  return { positions, width: stageWidth, height: stageHeight };
}

export function WorkflowTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const liveNodeId = useAgentStore((s) => s.liveWorkflowNodeId);
  const inFlight = useAgentStore((s) => s.inFlight);
  const workflow = config?.workflow;

  const baseLayout = useMemo(() => {
    if (!workflow) return null;
    return layout(workflow.nodes, workflow.edges);
  }, [workflow]);

  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which node currently has its "+ add child" popup open. */
  const [addMenuFor, setAddMenuFor] = useState<string | null>(null);
  /** Per-node pending state (so we can grey out actions during PATCH). */
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);

  // Per-node position overrides set by the user dragging nodes around.
  // Local-only — Alta's next workflow patch (or a refresh) re-runs the
  // auto-layout, which is fine: the graph stays readable.
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>(
    {},
  );

  // Reset overrides when the workflow id-set changes meaningfully (e.g. new
  // nodes added/removed) so the auto-layout gets a fresh canvas.
  const nodeIdsKey = workflow?.nodes.map((n) => n.id).join("|") ?? "";
  useEffect(() => {
    setOverrides({});
  }, [nodeIdsKey]);

  // Canvas pan: infinite-feeling playground via a translate transform on
  // the inner stage. The outer container clips overflow; you can pan
  // anywhere, including into empty space.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panState = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startPanX: number;
    startPanY: number;
  } | null>(null);
  const dragState = useRef<{
    nodeId: string;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  // Clear selection if the selected node disappears (e.g. Alta replaced
  // the workflow). The inspector only opens on explicit click — no auto-
  // select on mount or on liveNodeId changes.
  useEffect(() => {
    if (!workflow) return;
    if (selectedId && !workflow.nodes.some((n) => n.id === selectedId)) {
      setSelectedId(null);
    }
  }, [workflow, selectedId]);

  // Close the "+ add child" popup when clicking outside.
  useEffect(() => {
    if (!addMenuFor) return;
    const onDocDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".vb-el-add-menu, .vb-el-plus")) return;
      setAddMenuFor(null);
    };
    document.addEventListener("pointerdown", onDocDown);
    return () => document.removeEventListener("pointerdown", onDocDown);
  }, [addMenuFor]);

  // Center the graph in the viewport. Start at top-center; if the graph
  // grows taller than the viewport, anchor the bottom so new rows stay
  // visible ("camera follows the build").
  const recenter = () => {
    const el = scrollRef.current;
    if (!el || !baseLayout) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const gw = baseLayout.width * zoom;
    const gh = baseLayout.height * zoom;
    const targetX = (vw - gw) / 2;
    const targetY =
      gh + 80 < vh ? Math.max(40, (vh - gh) / 2 - 40) : vh - gh - 40;
    setPan({ x: targetX, y: targetY });
  };

  useEffect(() => {
    recenter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIdsKey, zoom]);

  if (!workflow || !baseLayout) return null;

  // Effective positions = baseLayout positions overridden by drag state.
  const getPos = (id: string) =>
    overrides[id] ?? baseLayout.positions.get(id) ?? { x: 0, y: 0 };

  const laid = {
    width: baseLayout.width,
    height: baseLayout.height,
    positions: new Map(
      workflow.nodes.map((n) => [n.id, getPos(n.id)] as const),
    ),
  };

  // ── Canvas pan: mousedown on empty area, move, up. Updates a translate
  // offset on the inner stage, so the user can drift into negative space.
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest(".vb-node")) return; // node handles its own
    const el = scrollRef.current;
    if (!el) return;
    el.setPointerCapture?.(e.pointerId);
    panState.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startPanX: pan.x,
      startPanY: pan.y,
    };
    el.style.cursor = "grabbing";
  };
  const onCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragState.current) {
      const dx = (e.clientX - dragState.current.startClientX) / zoom;
      const dy = (e.clientY - dragState.current.startClientY) / zoom;
      const nx = dragState.current.startX + dx;
      const ny = dragState.current.startY + dy;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragState.current.moved = true;
      setOverrides((prev) => ({
        ...prev,
        [dragState.current!.nodeId]: { x: nx, y: ny },
      }));
      return;
    }
    if (!panState.current?.active) return;
    const dx = e.clientX - panState.current.startX;
    const dy = e.clientY - panState.current.startY;
    setPan({
      x: panState.current.startPanX + dx,
      y: panState.current.startPanY + dy,
    });
  };
  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (panState.current?.active) {
      panState.current = null;
      if (el) el.style.cursor = "grab";
      el?.releasePointerCapture?.(e.pointerId);
    }
    if (dragState.current) {
      dragState.current = null;
      if (el) el.style.cursor = "grab";
    }
  };

  const onNodePointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    nodeId: string,
  ) => {
    e.stopPropagation();
    const pos = getPos(nodeId);
    dragState.current = {
      nodeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: pos.x,
      startY: pos.y,
      moved: false,
    };
    scrollRef.current?.setPointerCapture?.(e.pointerId);
  };
  const onNodeClick = (e: React.MouseEvent<HTMLButtonElement>, nodeId: string) => {
    // Suppress click if this was the end of a drag.
    if (dragState.current?.moved) {
      e.preventDefault();
      return;
    }
    setSelectedId(nodeId);
  };

  const applyConfigDirect = useAgentStore.getState().applyConfigDirect;

  const addChildNode = async (
    parentId: string,
    type: WorkflowNodeType,
    label: string,
  ) => {
    setPendingNodeId(parentId);
    setAddMenuFor(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/workflow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, label, after_node_id: parentId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Add failed (${res.status})`);
      }
      const json = (await res.json()) as {
        revision: number;
        patch: Partial<AgentConfigCache>;
      };
      applyConfigDirect(json.patch, json.revision);
    } catch (err) {
      // Quiet failure: surface via console for now; the panel inspector has
      // a proper error UI but the inline action does not yet.
      console.error("add node failed", err);
    } finally {
      setPendingNodeId(null);
    }
  };

  const deleteNode = async (nodeId: string) => {
    setPendingNodeId(nodeId);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/workflow/${nodeId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Delete failed (${res.status})`);
      }
      const json = (await res.json()) as {
        revision: number;
        patch: Partial<AgentConfigCache>;
      };
      applyConfigDirect(json.patch, json.revision);
      if (selectedId === nodeId) setSelectedId(null);
    } catch (err) {
      console.error("delete node failed", err);
    } finally {
      setPendingNodeId(null);
    }
  };

  return (
    <div className="relative h-full bg-(--color-panel-sunken)">
      {/* Floating toolbar — top-left of canvas, ElevenLabs-style icon bar */}
      <div className="vb-el-toolbar">
        <button
          className="vb-el-toolbtn"
          title="Zoom in"
          onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}
          aria-label="Zoom in"
        >
          <IconZoomIn />
        </button>
        <button
          className="vb-el-toolbtn"
          title="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
          aria-label="Zoom out"
        >
          <IconZoomOut />
        </button>
        <button
          className="vb-el-toolbtn"
          title="Fit"
          onClick={() => {
            setZoom(1);
            recenter();
          }}
          aria-label="Fit to screen"
        >
          <IconFit />
        </button>
        <span className="vb-el-sep" />
        <button
          className="vb-el-toolbtn"
          title="Group selected"
          aria-label="Group selected"
          disabled
        >
          <IconGroup />
        </button>
        <button
          className="vb-el-toolbtn"
          title="Duplicate"
          aria-label="Duplicate"
          disabled
        >
          <IconCopy />
        </button>
        {inFlight.has("workflow") && (
          <span className="ml-3 font-mono text-[10px] tracking-widest text-(--color-violet-600)">
            BUILDING…
          </span>
        )}
      </div>

      {/* Canvas */}
      <div
        ref={scrollRef}
        className="vb-flow-canvas"
        style={{
          cursor: "grab",
          touchAction: "none",
          overflow: "hidden",
          position: "absolute",
          inset: 0,
        }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={endPointer}
      >
        {workflow.nodes.length <= 1 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-(--color-muted)">
            Workflow will appear once Alta drafts it. Try “Sketch a workflow for
            triaging support calls.”
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              overflow: "hidden",
            }}
          >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: laid.width,
              height: laid.height,
              transformOrigin: "top left",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              willChange: "transform",
            }}
          >
            <svg
              width={laid.width}
              height={laid.height}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              <defs>
                <marker
                  id="vb-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-border-strong)" />
                </marker>
                <marker
                  id="vb-arrow-lit"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-accent)" />
                </marker>
              </defs>
              {workflow.edges.map((e) => {
                const a = laid.positions.get(e.from);
                const b = laid.positions.get(e.to);
                if (!a || !b) return null;
                // Left-to-right: from right-center of `a` to left-center of `b`.
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                const x2 = b.x;
                const y2 = b.y + NODE_H / 2;
                const midX = (x1 + x2) / 2;
                const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
                const isLit =
                  selectedId !== null &&
                  (e.from === selectedId || e.to === selectedId);
                return (
                  <g key={e.id}>
                    <path
                      d={path}
                      fill="none"
                      stroke={
                        isLit
                          ? "var(--color-accent)"
                          : "var(--color-border-strong)"
                      }
                      strokeWidth={isLit ? 2 : 1.5}
                      markerEnd={`url(#${isLit ? "vb-arrow-lit" : "vb-arrow"})`}
                    />
                    {e.label && (
                      <foreignObject
                        x={midX - 90}
                        y={(y1 + y2) / 2 - 12}
                        width={180}
                        height={24}
                        style={{ overflow: "visible" }}
                      >
                        <div className="vb-edge-pill">
                          <span aria-hidden>↳</span>
                          {e.label}
                        </div>
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </svg>

            {workflow.nodes.map((n) => {
              const p = laid.positions.get(n.id);
              if (!p) return null;
              const isSel = n.id === selectedId;
              const isLive = liveNodeId === n.id;
              const desc =
                (n.data?.prompt as string | undefined) ??
                (n.data?.instruction as string | undefined) ??
                (n.data?.field as string | undefined) ??
                (n.data?.expression as string | undefined) ??
                "";
              const isTerminal = n.type === "start" || n.type === "end";
              const nodeWidth = isTerminal ? 120 : NODE_W;
              const offsetX = isTerminal ? (NODE_W - 120) / 2 : 0;
              const isPending = pendingNodeId === n.id;
              const menuOpen = addMenuFor === n.id;
              const canDelete = n.id !== "start";
              return (
                <div
                  key={n.id}
                  className="vb-el-node-wrap"
                  style={{
                    position: "absolute",
                    left: p.x + offsetX,
                    top: p.y,
                    width: nodeWidth,
                  }}
                >
                  <button
                    type="button"
                    onPointerDown={(e) => onNodePointerDown(e, n.id)}
                    onClick={(e) => onNodeClick(e, n.id)}
                    className={`vb-el-node vb-el-${n.type} ${
                      isSel ? "selected" : ""
                    } ${isLive ? "lit-now" : ""} ${
                      isTerminal ? "vb-el-terminal" : ""
                    }`}
                    style={{
                      width: nodeWidth,
                      textAlign: "left",
                      cursor: "grab",
                      touchAction: "none",
                      opacity: isPending ? 0.6 : 1,
                    }}
                  >
                    <span
                      className={`vb-el-icon vb-el-icon-${n.type}`}
                      aria-hidden
                    >
                      {ICON[n.type]}
                    </span>
                    {isTerminal ? (
                      <span dir="auto" className="vb-el-terminal-label">
                        {n.label}
                      </span>
                    ) : (
                      <div className="vb-el-body">
                        <div dir="auto" className="vb-el-title">
                          {n.label}
                        </div>
                        {desc && (
                          <div dir="auto" className="vb-el-desc">
                            {desc}
                          </div>
                        )}
                      </div>
                    )}
                  </button>

                  {/* Right-side actions: copy (stub) + trash. Hidden until hover. */}
                  <div className="vb-el-node-side-actions">
                    <button
                      type="button"
                      title="Duplicate (coming soon)"
                      aria-label="Duplicate"
                      disabled
                      className="vb-el-side-btn"
                    >
                      <IconCopy />
                    </button>
                    {canDelete && (
                      <button
                        type="button"
                        title="Delete node"
                        aria-label="Delete node"
                        disabled={isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteNode(n.id);
                        }}
                        className="vb-el-side-btn vb-el-side-btn-danger"
                      >
                        <IconTrash />
                      </button>
                    )}
                  </div>

                  {/* Bottom "+ add child" — hidden until hover. */}
                  {n.type !== "end" && (
                    <button
                      type="button"
                      title="Add a node after this one"
                      aria-label="Add a node"
                      disabled={isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddMenuFor((cur) => (cur === n.id ? null : n.id));
                      }}
                      className={`vb-el-plus ${menuOpen ? "vb-el-plus-on" : ""}`}
                    >
                      +
                    </button>
                  )}

                  {/* Popup menu rooted at the "+" button. */}
                  {menuOpen && (
                    <div
                      className="vb-el-add-menu"
                      role="menu"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {ADD_NODE_MENU.map((opt) => (
                        <button
                          key={opt.type}
                          type="button"
                          role="menuitem"
                          className="vb-el-add-menu-item"
                          onClick={(e) => {
                            e.stopPropagation();
                            void addChildNode(n.id, opt.type, opt.defaultLabel);
                          }}
                        >
                          <span
                            className={`vb-el-icon vb-el-icon-${opt.type}`}
                            aria-hidden
                          >
                            {ICON[opt.type]}
                          </span>
                          <span className="vb-el-add-menu-label">
                            {opt.label}
                          </span>
                          <span className="vb-el-add-menu-hint">
                            {opt.hint}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        )}
      </div>

      {/* Right-side node inspector — opens on node click. */}
      {selectedId && (
        <NodeInspector
          agentId={agentId}
          node={workflow.nodes.find((n) => n.id === selectedId) ?? null}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ── Right-side inspector for the selected node ───────────────────────────
//
// Edits the node's label and the single "prompt-ish" data field that
// matches its type (prompt for speak/condition, instruction for tool_call,
// field for collect, expression for condition). Saves via the PATCH
// endpoint, then applies the patch directly to the store so the UI doesn't
// wait for a server round-trip.

const PROMPT_FIELD: Partial<Record<WorkflowNodeType, string>> = {
  speak: "prompt",
  collect: "prompt",
  condition: "expression",
  tool_call: "instruction",
  transfer: "instruction",
};

function NodeInspector({
  agentId,
  node,
  onClose,
}: {
  agentId: string;
  node: WorkflowNode | null;
  onClose: () => void;
}) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const promptKey = node ? PROMPT_FIELD[node.type] : undefined;

  const initialLabel = node?.label ?? "";
  const initialPrompt =
    node && promptKey ? ((node.data?.[promptKey] as string) ?? "") : "";

  const [label, setLabel] = useState(initialLabel);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the selected node id changes.
  useEffect(() => {
    setLabel(initialLabel);
    setPrompt(initialPrompt);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id]);

  if (!node) return null;

  const dirty = label !== initialLabel || prompt !== initialPrompt;

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
      if (promptKey && prompt !== initialPrompt) body.data = { [promptKey]: prompt };
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
            {node.label}
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
        <div className="vb-field">
          <div className="vb-field-label">Title</div>
          <input
            dir="auto"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="vb-field-input"
            placeholder="Node title"
          />
        </div>

        {promptKey ? (
          <div className="vb-field">
            <div className="vb-field-label">
              {promptKey === "expression"
                ? "Routing expression"
                : promptKey === "instruction"
                  ? "Instruction"
                  : "Prompt"}
            </div>
            <textarea
              dir="auto"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="vb-field-input vb-field-textarea"
              rows={10}
              placeholder={
                promptKey === "expression"
                  ? "e.g. issue_category"
                  : "What this node should say or do…"
              }
            />
            <p className="vb-field-hint">
              {promptKey === "expression"
                ? "Drives the router's branching. Variable names or short logical expressions."
                : "Free-text instruction the agent follows when it reaches this node."}
            </p>
          </div>
        ) : (
          <p className="vb-field-hint">
            This node has no prompt — it's a control point in the graph.
          </p>
        )}

        {error && (
          <p className="vb-field-hint" style={{ color: "var(--color-danger)" }}>
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
          disabled={!dirty || saving}
          className="rounded-md bg-(--color-foreground-strong) px-3 py-1.5 text-xs font-semibold text-white disabled:bg-(--color-border-strong) disabled:text-(--color-muted-soft)"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </aside>
  );
}

// ── Inline SVG icons, sized to fit the 14px toolbar slot. ────────────────
const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function IconZoomIn() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx={11} cy={11} r={7} />
      <line x1={21} y1={21} x2={16.65} y2={16.65} />
      <line x1={11} y1={8} x2={11} y2={14} />
      <line x1={8} y1={11} x2={14} y2={11} />
    </svg>
  );
}
function IconZoomOut() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx={11} cy={11} r={7} />
      <line x1={21} y1={21} x2={16.65} y2={16.65} />
      <line x1={8} y1={11} x2={14} y2={11} />
    </svg>
  );
}
function IconFit() {
  return (
    <svg {...ICON_PROPS}>
      <polyline points="4 9 4 4 9 4" />
      <polyline points="20 9 20 4 15 4" />
      <polyline points="4 15 4 20 9 20" />
      <polyline points="20 15 20 20 15 20" />
    </svg>
  );
}
function IconGroup() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx={6} cy={6} r={2} />
      <circle cx={18} cy={6} r={2} />
      <circle cx={12} cy={18} r={2} />
      <path d="M6 8v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
      <line x1={12} y1={12} x2={12} y2={16} />
    </svg>
  );
}
function IconCopy() {
  return (
    <svg {...ICON_PROPS}>
      <rect x={9} y={9} width={11} height={11} rx={2} />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg {...ICON_PROPS}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

