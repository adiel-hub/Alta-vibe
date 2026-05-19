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
import { useWorkflowReveal } from "./useWorkflowReveal";
import { createClientLogger } from "@/lib/clientLogger";

const log = createClientLogger("workflow");

type InspectorVoice = {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
};

// Module-level cache so opening the inspector on different nodes doesn't
// hit /api/voices every time. Mirrors what VoiceTab does, but kept here so
// we don't pull in that whole component.
let voicesPromise: Promise<InspectorVoice[]> | null = null;
function loadVoicesCached(): Promise<InspectorVoice[]> {
  voicesPromise ??= appFetch(`/api/voices`).then(async (r) => {
    if (!r.ok) throw new Error(`Voices request failed (${r.status})`);
    const j = (await r.json()) as { voices: InspectorVoice[] };
    return j.voices;
  });
  return voicesPromise;
}

const NODE_W = 260;
const NODE_H = 96;
const COL_GAP = 160;
const ROW_GAP = 88;
const PADDING = 32;
const EDGE_LABEL_W = 140;
/**
 * Visible height of a terminal pill ("Call connects" / "End call"). Used
 * only for edge-anchor y so connectors meet the pill's visual middle
 * instead of the slot's geometric middle. Matches the rendered pill height
 * for a 2-line label (the longest the auto-stamped terminals reach). For
 * a 1-line label the connector lands slightly high but still inside the
 * pill — much better than the old slot-center anchor which landed below
 * the pill entirely.
 */
const TERMINAL_H = 56;

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
 *
 * IMPORTANT: this MUST be a plain BFS (each node receives its depth on
 * first visit and is then frozen). The previous version re-enqueued a
 * node every time it was reached via a longer path
 * (`if (cur === undefined || cur < d + 1)`), which is non-terminating on
 * any cyclic graph and exponential on a DAG with multiple paths —
 * exactly the workflows the agent generates ("if unresolved → speak
 * again"). The browser tab hung on the first mount of WorkflowTab.
 */
function layout(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const t0 =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const list = outgoing.get(e.from);
    if (list) list.push(e.to);
    else outgoing.set(e.from, [e.to]);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];
  const startNode = nodes.find((n) => n.id === "start");
  if (startNode) {
    depth.set(startNode.id, 0);
    queue.push(startNode.id);
  }
  // Also seed any other roots (no incoming edges) at depth 0 so disconnected
  // subgraphs still get laid out instead of falling through to the catch-all
  // depth-zero pass below.
  const hasIncoming = new Set<string>();
  for (const e of edges) if (byId.has(e.to)) hasIncoming.add(e.to);
  for (const n of nodes) {
    if (n.id === startNode?.id) continue;
    if (!hasIncoming.has(n.id) && !depth.has(n.id)) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }

  // Standard BFS: each reachable node gets a depth ONCE, on first visit.
  // The defensive iteration cap is paranoia in case a future refactor
  // reintroduces re-enqueueing — it cannot be hit by the algorithm below.
  const MAX_ITER = nodes.length * 4 + 16;
  let iter = 0;
  while (queue.length) {
    if (++iter > MAX_ITER) {
      log.error("layout BFS hit iteration cap", {
        nodes: nodes.length,
        edges: edges.length,
        max_iter: MAX_ITER,
      });
      break;
    }
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push(next);
    }
  }
  // Any nodes left over (reachable only via cycles, or completely
  // disconnected) — anchor them at depth 0 so the renderer doesn't NaN.
  let strandedCount = 0;
  for (const n of nodes) {
    if (!depth.has(n.id)) {
      depth.set(n.id, 0);
      strandedCount++;
    }
  }

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
  const t1 =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  log.debug("layout computed", {
    nodes: nodes.length,
    edges: edges.length,
    bfs_iter: iter,
    stranded: strandedCount,
    columns: columns.size,
    tallest_col: tallest,
    stage_w: stageWidth,
    stage_h: stageHeight,
    ms: Math.round((t1 - t0) * 100) / 100,
  });
  return { positions, width: stageWidth, height: stageHeight };
}

export function WorkflowTab({ agentId }: { agentId: string }) {
  // Subscribe to the workflow slice directly, not the whole `config`.
  // `applyPatch` creates a fresh `config` reference on every tool call, so
  // reading `s.config` here would re-render the canvas on every unrelated
  // tool (voice, llm, etc.) too — that re-render storm is one of the things
  // that makes the page freeze when `set_workflow` lands mid-stream.
  const workflow = useAgentStore((s) => s.config?.workflow);
  const liveNodeId = useAgentStore((s) => s.liveWorkflowNodeId);
  const inFlight = useAgentStore((s) => s.inFlight);

  // ── Render diagnostics ────────────────────────────────────────────────
  // Bump on every render so we can correlate freezes with re-render storms.
  // The render counter, the workflow reference identity, and the layout
  // duration together tell us whether stuck = "rendered 1000x" or stuck =
  // "one render took 4s in layout()".
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const lastWorkflowRef = useRef<typeof workflow>(undefined);
  const workflowRefChanged = lastWorkflowRef.current !== workflow;
  lastWorkflowRef.current = workflow;
  log.trace("render", {
    render_n: renderCountRef.current,
    nodes: workflow?.nodes.length,
    edges: workflow?.edges.length,
    workflow_ref_changed: workflowRefChanged,
    live_node: liveNodeId,
    in_flight_workflow: inFlight.has("workflow"),
  });

  // Stagger the appearance of newly-added nodes/edges so a large
  // `set_workflow` patch doesn't slam everything onto the canvas in one
  // synchronous paint — that's what was freezing the browser when chat
  // streaming overlapped with the workflow build. See useWorkflowReveal.
  const { visibleNodeIds, visibleEdgeIds, isBuilding } =
    useWorkflowReveal(workflow);

  const baseLayout = useMemo(() => {
    if (!workflow) return null;
    return layout(workflow.nodes, workflow.edges);
  }, [workflow]);

  // First-mount audit — surfaces what we found when the user clicks into
  // the workflow tab on a previously-built agent (the scenario that was
  // hanging the browser before the BFS fix landed).
  useEffect(() => {
    log.info("WorkflowTab mounted", {
      agent_id: agentId,
      nodes: workflow?.nodes.length ?? 0,
      edges: workflow?.edges.length ?? 0,
      node_ids: workflow?.nodes.map((n) => n.id).slice(0, 8),
      edge_count_by_type: {
        with_condition:
          workflow?.edges.filter((e) => e.condition && e.condition.length > 0)
            .length ?? 0,
        plain:
          workflow?.edges.filter((e) => !e.condition || e.condition.length === 0)
            .length ?? 0,
      },
      stage_w: baseLayout?.width,
      stage_h: baseLayout?.height,
    });
    // intentionally only on mount — we want to see the moment the tab
    // appears, not every subsequent state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start zoomed out so more of the graph is visible on first paint.
  // Users can hit Fit (which now resets to this same default) or scroll
  // to zoom further.
  const [zoom, setZoom] = useState(0.75);
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

  // ── Focal-point zoom ─────────────────────────────────────────────────
  // Zoom around a screen point (cx, cy) so the canvas point under the
  // cursor stays under the cursor. Used by the wheel handler and by the
  // toolbar +/− buttons (which zoom around the viewport center).
  //
  // Math: before zoom, screen (cx, cy) maps to canvas
  //   ((cx − pan.x) / z, (cy − pan.y) / z).
  // After zoom z' we want the same screen point to map to the same canvas
  // point, so pan' = c − (c − pan) · (z'/z).
  const Z_MIN = 0.4;
  const Z_MAX = 2;
  const zoomAround = (factor: number, cx: number, cy: number) => {
    setZoom((zCur) => {
      const raw = zCur * factor;
      const zNext = Math.max(Z_MIN, Math.min(Z_MAX, +raw.toFixed(3)));
      if (zNext === zCur) return zCur;
      const ratio = zNext / zCur;
      setPan((p) => ({
        x: cx - (cx - p.x) * ratio,
        y: cy - (cy - p.y) * ratio,
      }));
      return zNext;
    });
  };

  // Native (non-passive) wheel listener so we can preventDefault and
  // suppress the browser's page-zoom on pinch / cmd-wheel. React's onWheel
  // prop is passive in newer React versions — addEventListener with
  // { passive: false } is the only reliable way to stop the default.
  //
  //   • plain wheel              → focal-point zoom toward cursor
  //   • ctrl/cmd + wheel         → focal-point zoom (also covers trackpad
  //                                pinch, which the browser surfaces as a
  //                                wheel event with ctrlKey: true)
  //   • shift + wheel            → horizontal pan
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      // Shift+wheel: pan horizontally. Don't intercept if a modifier is
      // also held — that's a zoom intent.
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setPan((p) => ({ x: p.x - e.deltaY, y: p.y - e.deltaX }));
        return;
      }
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Exponential mapping so one mouse-wheel notch (deltaY ≈ 100) gives
      // a ~14% zoom step, and trackpad fine-grained scrolls feel smooth.
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAround(factor, cx, cy);
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
    // scrollRef is a ref and zoomAround closes over stable functional
    // setters (setZoom / setPan), so an empty dep array is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    // intentionally NOT re-running on `zoom` — the wheel handler does its
    // own focal-point pan, and a recenter on every zoom step would fight
    // it. Toolbar +/− route through `zoomAround` and the Fit button
    // explicitly calls `recenter()`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIdsKey]);

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
    // The whole node footprint — body, side actions, "+" button, popup
    // menu — sits inside .vb-el-node-wrap. Excluding it here keeps the
    // canvas pan handler from stealing pointer capture and eating the
    // click on the "+" or trash buttons.
    if ((e.target as HTMLElement).closest(".vb-el-node-wrap")) return;
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
      // Synthesise a "click" if the pointer never actually moved past
      // the drag threshold. We can't rely on the node button's onClick
      // here because setPointerCapture on the canvas redirects pointerup
      // away from the node, and the browser then doesn't fire click on
      // the original target.
      if (!dragState.current.moved) {
        setSelectedId(dragState.current.nodeId);
        setAddMenuFor(null);
      }
      dragState.current = null;
      if (el) el.style.cursor = "grab";
      el?.releasePointerCapture?.(e.pointerId);
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
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            zoomAround(1.1, el.clientWidth / 2, el.clientHeight / 2);
          }}
          aria-label="Zoom in"
        >
          <IconZoomIn />
        </button>
        <button
          className="vb-el-toolbtn"
          title="Zoom out"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            zoomAround(1 / 1.1, el.clientWidth / 2, el.clientHeight / 2);
          }}
          aria-label="Zoom out"
        >
          <IconZoomOut />
        </button>
        <button
          className="vb-el-toolbtn"
          title="Fit"
          onClick={() => {
            setZoom(0.75);
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
        {(inFlight.has("workflow") || isBuilding) && (
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
                // Terminal nodes (start / end) render as a narrower pill
                // (120px wide) centered inside the 260px column slot, so
                // their visible right/left edges are offset from the slot
                // bounds. Without this adjustment the edge floats in empty
                // space for ~70px before reaching the next node — visible
                // as a gap after "Call connects" / before an "End call".
                const fromNode = workflow.nodes.find((n) => n.id === e.from);
                const toNode = workflow.nodes.find((n) => n.id === e.to);
                const fromTerminal =
                  fromNode?.type === "start" || fromNode?.type === "end";
                const toTerminal =
                  toNode?.type === "start" || toNode?.type === "end";
                const TERM_W = 120;
                const termOffsetX = (NODE_W - TERM_W) / 2;
                const x1 = a.x + (fromTerminal ? termOffsetX + TERM_W : NODE_W);
                // Terminal pills are vertically TOP-aligned in their 96px
                // slot and only ~56px tall, so anchoring the edge at
                // slot-center (y + 48) lands near the bottom of the pill,
                // visibly off-center. Use the pill's own midpoint instead.
                const y1 =
                  a.y + (fromTerminal ? TERMINAL_H / 2 : NODE_H / 2);
                const x2 = b.x + (toTerminal ? termOffsetX : 0);
                const y2 = b.y + (toTerminal ? TERMINAL_H / 2 : NODE_H / 2);
                const midX = (x1 + x2) / 2;
                const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
                const isLit =
                  selectedId !== null &&
                  (e.from === selectedId || e.to === selectedId);
                const revealed = visibleEdgeIds.has(e.id);
                return (
                  <g
                    key={e.id}
                    className={`vb-edge ${revealed ? "vb-edge-revealed" : "vb-edge-pending"}`}
                  >
                    <path
                      d={path}
                      pathLength={1}
                      className="vb-edge-path"
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
                        x={midX - EDGE_LABEL_W / 2}
                        y={(y1 + y2) / 2 - 12}
                        width={EDGE_LABEL_W}
                        height={24}
                        style={{ overflow: "visible" }}
                      >
                        <div
                          className="vb-edge-pill"
                          style={{ maxWidth: EDGE_LABEL_W }}
                        >
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
              const revealed = visibleNodeIds.has(n.id);
              return (
                <div
                  key={n.id}
                  className={`vb-el-node-wrap ${revealed ? "vb-el-revealed" : "vb-el-reveal-pending"}`}
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

                  {/* Bottom "+ add child" — hidden until hover. Delete is
                      reachable from the inspector once a node is selected. */}
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
          outgoingEdges={workflow.edges.filter((e) => e.from === selectedId)}
          allNodes={workflow.nodes}
          onDelete={async () => {
            await deleteNode(selectedId);
          }}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

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
function NodeInspector({
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

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="vb-field">
      <div className="vb-field-label">{label}</div>
      {children}
      {hint && <p className="vb-field-hint">{hint}</p>}
    </div>
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

