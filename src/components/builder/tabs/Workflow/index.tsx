"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type {
  AgentConfigCache,
  RuntimePhase,
  RuntimeTool,
  WorkflowNodeType,
} from "@/types/agent";
import { friendlyForTool } from "@/lib/capabilities/toolDisplay";
import { useWorkflowReveal } from "./useWorkflowReveal";
import {
  ADD_NODE_MENU,
  COL_GAP,
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
  const inFlight = useAgentStore((s) => s.inFlight);
  // Pre/post-call tools are NOT part of the workflow graph (they fire
  // outside the in-call lifecycle — pre before initiateOutboundCall, post
  // when ElevenLabs' workspace webhook hits us). Render them as phantom
  // nodes flanking `start` / `end` so users see the call's full envelope
  // without polluting the actual workflow graph that goes to ElevenLabs.
  const allTools = useAgentStore((s) => s.config?.tools);
  const { preCallTools, postCallTools } = useMemo(() => {
    const tools = allTools ?? [];
    return {
      preCallTools: tools.filter((t) => t.phase === "pre_call"),
      postCallTools: tools.filter((t) => t.phase === "post_call"),
    };
  }, [allTools]);

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
    const boundInCall = (workflow?.nodes ?? []).filter(
      (n) => n.type === "tool_call" && !!(n.data?.tool_id as string | undefined),
    ).length;
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
      pre_call_count: preCallTools.length,
      post_call_count: postCallTools.length,
      bound_in_call_count: boundInCall,
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
    // menu — sits inside .vb-el-node-wrap. Phantom cards / ambient chips
    // / their popovers live OUTSIDE that wrapper. Excluding all of these
    // here keeps the canvas pan handler from stealing pointer capture
    // and eating the click on the "+", trash, or "+ Pre-call tool"
    // buttons (the captured canvas swallows the subsequent click).
    if (
      (e.target as HTMLElement).closest(
        ".vb-el-node-wrap, .vb-el-phantom, .vb-el-phantom-add, .vb-el-phantom-popover",
      )
    )
      return;
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
      // Capture nodeId locally — the setOverrides updater runs during React's
      // commit phase, by which time dragState.current may have been nulled
      // by endPointer firing on a different pointer event.
      const nodeId = dragState.current.nodeId;
      setOverrides((prev) => ({
        ...prev,
        [nodeId]: { x: nx, y: ny },
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
              // For tool_call nodes, resolve the bound tool from the agent's
              // installed tools so we can render a chip on the card. Two
              // failure modes worth distinguishing visually:
              //   - tool_id missing entirely    → "No tool selected" hint
              //   - tool_id set but unknown id  → "Tool not found" warning
              //     (e.g. the tool was uninstalled but the node still
              //     references it).
              const boundTool: RuntimeTool | "missing" | "unbound" =
                n.type === "tool_call"
                  ? (() => {
                      const toolId = n.data?.tool_id as string | undefined;
                      const toolName = n.data?.tool_name as string | undefined;
                      if (!toolId && !toolName) return "unbound" as const;
                      const pool = allTools ?? [];
                      const byId = toolId
                        ? pool.find((t: RuntimeTool) => t.id === toolId)
                        : null;
                      if (byId) return byId;
                      const byName = toolName
                        ? pool.find((t: RuntimeTool) => t.name === toolName)
                        : null;
                      return byName ?? ("missing" as const);
                    })()
                  : "unbound";
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
                    } ${
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
                        {n.type === "tool_call" && boundTool !== "unbound" && (
                          boundTool === "missing" ? (
                            <div className="vb-el-tool-chip vb-el-tool-chip-missing">
                              <span aria-hidden>⚠</span>
                              <span>Tool not found</span>
                            </div>
                          ) : (
                            <div
                              className="vb-el-tool-chip"
                              title={boundTool.description}
                            >
                              <span aria-hidden>
                                {friendlyForTool(boundTool.name).emoji}
                              </span>
                              <span className="vb-el-tool-chip-label">
                                {friendlyForTool(boundTool.name).label}
                              </span>
                              {boundTool.provider && (
                                <span className="vb-el-tool-chip-provider">
                                  {boundTool.provider}
                                </span>
                              )}
                            </div>
                          )
                        )}
                        {n.type === "tool_call" && boundTool === "unbound" && (
                          <div className="vb-el-tool-chip vb-el-tool-chip-unbound">
                            No tool selected
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

            {/* ── Phantom pre/post-call tool cards ────────────────────────
                Rendered as decorations flanking `start` / `end`. They are
                NOT in `workflow.nodes` — projectAgentConfig never sees
                them, ElevenLabs is unaware they exist. The user gets a
                visual reminder of the call's full envelope (what fires
                before the greeting, what fires after hangup) without
                polluting the in-call graph. Clicking a phantom jumps to
                the Tools tab where it can actually be edited / removed. */}
            {(() => {
              const start = workflow.nodes.find((n) => n.type === "start");
              const preAnchor = start
                ? laid.positions.get(start.id) ?? null
                : null;
              // Prefer the right-most explicit `end` node, but fall back
              // to the right-most node of any type. Without this fallback
              // the post-call lane silently disappears on fresh workflows
              // (DEFAULT_WORKFLOW ships with only a `start` node).
              const ends = workflow.nodes.filter((n) => n.type === "end");
              const pool = ends.length > 0 ? ends : workflow.nodes;
              let postAnchor: { x: number; y: number } | null = null;
              for (const n of pool) {
                const p = laid.positions.get(n.id);
                if (!p) continue;
                if (!postAnchor || p.x > postAnchor.x) postAnchor = p;
              }
              return (
                <>
                  <PhantomLifecycleColumn
                    agentId={agentId}
                    tools={preCallTools}
                    anchor={preAnchor}
                    side="left"
                  />
                  <PhantomLifecycleColumn
                    agentId={agentId}
                    tools={postCallTools}
                    anchor={postAnchor}
                    side="right"
                  />
                </>
              );
            })()}
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

/**
 * Decorative pre/post-call tool cards that flank the workflow's start /
 * end nodes. They are NOT workflow nodes — projectAgentConfig never sees
 * them, ElevenLabs is unaware they exist. Their sole purpose is to make
 * the call's full lifecycle visible inside the workflow tab so users
 * understand which tools fire outside the in-call graph.
 *
 * `anchor` is the position of the start (for `side="left"`) or end (for
 * `side="right"`) node, in the same coordinate space as the laid-out
 * workflow nodes. Tools stack vertically next to that anchor and are
 * connected to it with a dashed link.
 */
function PhantomLifecycleColumn({
  agentId,
  tools,
  anchor,
  side,
}: {
  agentId: string;
  tools: RuntimeTool[];
  anchor: { x: number; y: number } | null;
  side: "left" | "right";
}) {
  const phase: RuntimePhase = side === "left" ? "pre_call" : "post_call";
  const [inspectorFor, setInspectorFor] = useState<RuntimeTool | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function uninstall(toolName: string) {
    setBusyKey(`uninstall:${toolName}`);
    setActionError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/provider-tools?name=${encodeURIComponent(toolName)}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as {
        revision?: number;
        tools?: RuntimeTool[];
        error?: string;
      };
      if (!res.ok || !data.tools) {
        setActionError(data.error ?? `Uninstall failed (${res.status})`);
        return;
      }
      useAgentStore
        .getState()
        .applyConfigDirect({ tools: data.tools }, data.revision ?? 0);
      setInspectorFor(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Uninstall failed");
    } finally {
      setBusyKey(null);
    }
  }

  if (!anchor) return null;
  // Phantom cards are slightly smaller than real workflow nodes to read as
  // "different / informational" without forcing a separate scale on the
  // whole canvas.
  const PHANTOM_W = 220;
  const PHANTOM_H = 56;
  const ADD_BTN_H = 32;
  const GAP = 12;
  // Pre-call cards sit to the LEFT of start, post-call to the RIGHT of end.
  const colX =
    side === "left"
      ? anchor.x - PHANTOM_W - COL_GAP
      : anchor.x + NODE_W + COL_GAP;
  // Vertically center the stack (cards + add button) around the anchor's
  // slot midpoint.
  const stackHeight =
    tools.length * PHANTOM_H + tools.length * GAP + ADD_BTN_H;
  const startY = anchor.y + NODE_H / 2 - stackHeight / 2;

  return (
    <>
      {/* Phantom cards + dashed connectors. */}
      {tools.map((t, i) => {
        const y = startY + i * (PHANTOM_H + GAP);
        const friendly = friendlyForTool(t.name);
        const ax = side === "left" ? colX + PHANTOM_W : anchor.x + NODE_W;
        const ay = y + PHANTOM_H / 2;
        const bx = side === "left" ? anchor.x : colX;
        const by = anchor.y + NODE_H / 2;
        const midX = (ax + bx) / 2;
        const path = `M ${ax} ${ay} C ${midX} ${ay}, ${midX} ${by}, ${bx} ${by}`;
        return (
          <div key={t.id} style={{ position: "absolute", inset: 0 }}>
            <svg
              width="100%"
              height="100%"
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                overflow: "visible",
              }}
            >
              <path
                d={path}
                fill="none"
                stroke="var(--color-border-strong)"
                strokeWidth={1.25}
                strokeDasharray="4 4"
                opacity={0.55}
              />
            </svg>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setInspectorFor(t);
              }}
              className="vb-el-phantom"
              style={{
                position: "absolute",
                left: colX,
                top: y,
                width: PHANTOM_W,
                height: PHANTOM_H,
                cursor: "pointer",
                textAlign: "left",
              }}
              title={
                side === "left"
                  ? "Pre-call — fires before the agent's greeting"
                  : "Post-call — fires after the call ends"
              }
            >
              <div className="vb-el-phantom-tag">
                {side === "left" ? "Pre-call" : "Post-call"}
              </div>
              <div className="vb-el-phantom-body">
                <span className="vb-el-phantom-emoji" aria-hidden>
                  {friendly.emoji}
                </span>
                <span className="vb-el-phantom-label">{friendly.label}</span>
              </div>
            </button>
          </div>
        );
      })}

      {/* "+ Add" button at the bottom of the column. Always visible — when
          the column is empty, it's the only thing in the lane, so users
          discover where to wire pre/post tools without leaving the
          workflow tab. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPickerOpen(true);
        }}
        className="vb-el-phantom-add"
        style={{
          position: "absolute",
          left: colX,
          top: startY + tools.length * (PHANTOM_H + GAP),
          width: PHANTOM_W,
          height: ADD_BTN_H,
        }}
      >
        + {side === "left" ? "Pre-call tool" : "Post-call tool"}
      </button>

      {/* Inspector popover — opens when a phantom card is clicked. Shows the
          tool's friendly name, description, the dynamic-variable keys its
          output exposes (pre_call only), and a Remove button. */}
      {inspectorFor && (
        <PhantomInspectorPopover
          tool={inspectorFor}
          side={side}
          x={colX}
          y={(() => {
            const i = tools.findIndex((t) => t.id === inspectorFor.id);
            return startY + Math.max(0, i) * (PHANTOM_H + GAP);
          })()}
          width={PHANTOM_W}
          height={PHANTOM_H}
          busy={busyKey === `uninstall:${inspectorFor.name}`}
          error={actionError}
          onRemove={() => uninstall(inspectorFor.name)}
          onClose={() => {
            setInspectorFor(null);
            setActionError(null);
          }}
        />
      )}

      {/* Full Tools picker modal — same one used by the workflow node "+"
          button, defaulted to this lane's phase so the user lands on the
          right tab. Installing inside the modal updates the store
          directly, so no extra wiring is needed here. */}
      {pickerOpen && (
        <ToolPickerModal
          initialPhase={phase}
          title={`Add ${phase === "pre_call" ? "pre-call" : "post-call"} tool`}
          subtitle={
            phase === "pre_call"
              ? "Fires from our backend before the agent's greeting. Output is exposed as {{pre_<tool>__<field>}} dynamic variables."
              : "Fires from our backend after the call ends. Use for logging, CRM updates, or evaluation."
          }
          onPick={() => {
            setPickerOpen(false);
            setActionError(null);
          }}
          onClose={() => {
            setPickerOpen(false);
            setActionError(null);
          }}
        />
      )}
    </>
  );
}

function PhantomInspectorPopover({
  tool,
  side,
  x,
  y,
  width,
  height,
  busy,
  error,
  onRemove,
  onClose,
}: {
  tool: RuntimeTool;
  side: "left" | "right";
  x: number;
  y: number;
  width: number;
  height: number;
  busy: boolean;
  error: string | null;
  onRemove: () => void;
  onClose: () => void;
}) {
  const friendly = friendlyForTool(tool.name);
  // Pop the inspector to the side of the card so it doesn't cover the
  // card itself.
  const popX = side === "left" ? x - 260 - 12 : x + width + 12;
  return (
    <div
      style={{
        position: "absolute",
        left: popX,
        top: y - 4,
        width: 260,
        zIndex: 60,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="vb-el-phantom-popover">
        <div className="vb-el-phantom-popover-head">
          <span aria-hidden style={{ fontSize: 14 }}>
            {friendly.emoji}
          </span>
          <span className="vb-el-phantom-popover-title">
            {friendly.label}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="vb-el-phantom-popover-close"
          >
            ✕
          </button>
        </div>
        <div className="vb-el-phantom-popover-meta">
          <span className="vb-el-phantom-tag">
            {side === "left" ? "Pre-call" : "Post-call"}
          </span>
          {tool.provider && (
            <span className="vb-el-phantom-popover-provider">
              {tool.provider}
            </span>
          )}
        </div>
        <p className="vb-el-phantom-popover-desc">{tool.description}</p>
        {side === "left" && (
          <div className="vb-el-phantom-popover-vars">
            <div className="vb-el-phantom-popover-varhead">
              Outputs available as
            </div>
            <code className="vb-el-phantom-popover-varcode">
              {`{{pre_${tool.name}__<field>}}`}
            </code>
          </div>
        )}
        {error && (
          <div className="vb-el-phantom-popover-error">{error}</div>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="vb-el-phantom-popover-remove"
        >
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
      {/* Click-outside swallow so we don't immediately close ourselves. */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: -1,
        }}
      />
      {/* Suppress unused warning */}
      <span style={{ display: "none" }}>{height}</span>
    </div>
  );
}

