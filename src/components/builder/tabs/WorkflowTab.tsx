"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "@/types/agent";

const NODE_W = 260;
const NODE_H = 96;
const COL_GAP = 32;
const ROW_GAP = 76;
const PADDING = 32;

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

  // Top-down: depth → row (y), sibling-in-depth → column (x).
  const rows = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? [];
    row.push(n.id);
    rows.set(d, row);
  }

  const widest = Math.max(
    1,
    ...Array.from(rows.values()).map((arr) => arr.length),
  );
  const stageWidth = PADDING * 2 + widest * NODE_W + (widest - 1) * COL_GAP;

  const positions = new Map<string, { x: number; y: number }>();
  for (const [rowIdx, ids] of rows) {
    const totalW = ids.length * NODE_W + (ids.length - 1) * COL_GAP;
    const startX = (stageWidth - totalW) / 2;
    ids.forEach((id, sib) => {
      positions.set(id, {
        x: startX + sib * (NODE_W + COL_GAP),
        y: PADDING + rowIdx * (NODE_H + ROW_GAP),
      });
    });
  }

  const maxRow = Math.max(0, ...Array.from(rows.keys()));
  const stageHeight = PADDING * 2 + (maxRow + 1) * NODE_H + maxRow * ROW_GAP;
  return { positions, width: stageWidth, height: stageHeight };
}

export function WorkflowTab() {
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
    setPan({ x: 0, y: 0 });
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

  // Auto-select the node Alta is currently animating, falls back to start.
  useEffect(() => {
    if (!workflow) return;
    if (selectedId && workflow.nodes.some((n) => n.id === selectedId)) return;
    if (liveNodeId) setSelectedId(liveNodeId);
    else setSelectedId(workflow.nodes[0]?.id ?? null);
  }, [workflow, liveNodeId, selectedId]);

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
            setPan({ x: 0, y: 0 });
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
        <span className="vb-el-sep" />
        <button
          className="vb-el-toolbtn vb-el-toolbtn-wide"
          title="Templates"
          aria-label="Templates"
          disabled
        >
          <IconTemplates />
          <span>Templates</span>
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
                // Top-down: from bottom-center of `a` to top-center of `b`.
                const x1 = a.x + NODE_W / 2;
                const y1 = a.y + NODE_H;
                const x2 = b.x + NODE_W / 2;
                const y2 = b.y;
                const midY = (y1 + y2) / 2;
                const path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
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
                        x={(x1 + x2) / 2 - 90}
                        y={midY - 12}
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
              // Pull a short description out of node.data — varies by type.
              const desc =
                (n.data?.prompt as string | undefined) ??
                (n.data?.instruction as string | undefined) ??
                (n.data?.field as string | undefined) ??
                (n.data?.expression as string | undefined) ??
                "";
              const isTerminal = n.type === "start" || n.type === "end";
              return (
                <button
                  key={n.id}
                  type="button"
                  onPointerDown={(e) => onNodePointerDown(e, n.id)}
                  onClick={(e) => onNodeClick(e, n.id)}
                  className={`vb-el-node vb-el-${n.type} ${
                    isSel ? "selected" : ""
                  } ${isLive ? "lit-now" : ""} ${
                    isTerminal ? "vb-el-terminal" : ""
                  }`}
                  style={{
                    position: "absolute",
                    left: p.x,
                    top: p.y,
                    width: isTerminal ? 120 : NODE_W,
                    textAlign: "left",
                    cursor: "grab",
                    touchAction: "none",
                    // Re-center terminal nodes since they're narrower.
                    transform: isTerminal
                      ? `translateX(${(NODE_W - 120) / 2}px)`
                      : undefined,
                  }}
                >
                  <span className={`vb-el-icon vb-el-icon-${n.type}`} aria-hidden>
                    {ICON[n.type]}
                  </span>
                  {isTerminal ? (
                    <span className="vb-el-terminal-label">{n.label}</span>
                  ) : (
                    <div className="vb-el-body">
                      <div className="vb-el-title">{n.label}</div>
                      {desc && <div className="vb-el-desc">{desc}</div>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          </div>
        )}
      </div>
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
function IconTemplates() {
  return (
    <svg {...ICON_PROPS}>
      <rect x={3} y={3} width={7} height={7} rx={1} />
      <rect x={14} y={3} width={7} height={7} rx={1} />
      <rect x={3} y={14} width={7} height={7} rx={1} />
      <rect x={14} y={14} width={7} height={7} rx={1} />
    </svg>
  );
}

