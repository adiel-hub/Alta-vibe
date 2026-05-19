"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type { AgentConfigCache, WorkflowNodeType } from "@/types/agent";
import { useWorkflowReveal } from "./useWorkflowReveal";
import {
  ADD_NODE_MENU,
  EDGE_LABEL_W,
  ICON,
  NODE_H,
  NODE_W,
  TERMINAL_H,
} from "./_shared/constants";
import { log } from "./_shared/logger";
import {
  IconCopy,
  IconFit,
  IconGroup,
  IconZoomIn,
  IconZoomOut,
} from "./_shared/icons";
import { layout } from "./layout";
import { NodeInspector } from "./NodeInspector";
import { ToolPickerModal } from "./ToolPickerModal";

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
  // Parent node id that's waiting for the tool picker modal to resolve.
  // Picking "Tool" from the kinds menu closes the popover and opens a
  // centered modal that renders <ToolsTab mode="pick" />, so the picker
  // looks identical to the standalone Tools tab. null = modal closed.
  const [toolPickerFor, setToolPickerFor] = useState<string | null>(null);
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
    data?: Record<string, unknown>,
  ) => {
    setPendingNodeId(parentId);
    setAddMenuFor(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/workflow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type,
          label,
          after_node_id: parentId,
          ...(data ? { data } : {}),
        }),
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

                  {/* Popup menu rooted at the "+" button. Picking "Tool"
                      closes this popover and opens the modal that renders
                      <ToolsTab mode="pick" />, so the tool picker reuses the
                      exact same UI as the Tools tab. Other node types create
                      immediately like before. */}
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
                            if (opt.type === "tool_call") {
                              setAddMenuFor(null);
                              setToolPickerFor(n.id);
                              return;
                            }
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

      {toolPickerFor && (
        <ToolPickerModal
          onClose={() => setToolPickerFor(null)}
          onPick={(tool) => {
            const parentId = toolPickerFor;
            setToolPickerFor(null);
            void addChildNode(parentId, "tool_call", tool.name, {
              tool_id: tool.id,
            });
          }}
        />
      )}
    </div>
  );
}
