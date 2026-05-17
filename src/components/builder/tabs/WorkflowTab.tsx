"use client";

import { useEffect, useMemo, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "@/types/agent";

const NODE_W = 200;
const NODE_H = 60;
const COL_GAP = 32;
const ROW_GAP = 64;
const PADDING = 32;

const TYPE_LABEL: Record<WorkflowNodeType, string> = {
  start: "start",
  speak: "say",
  collect: "ask",
  condition: "router",
  tool_call: "tool",
  transfer: "transfer",
  end: "end",
};

const LEGEND: Array<{ kind: WorkflowNodeType; color: string; label: string }> = [
  { kind: "speak", color: "var(--color-indigo-500)", label: "Say" },
  { kind: "collect", color: "var(--color-violet-500)", label: "Ask" },
  { kind: "condition", color: "var(--color-orange-600)", label: "Router" },
  { kind: "tool_call", color: "var(--color-green-alta)", label: "Tool" },
  { kind: "transfer", color: "var(--color-amber-500)", label: "Transfer" },
  { kind: "end", color: "var(--color-muted)", label: "End" },
];

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

export function WorkflowTab() {
  const config = useAgentStore((s) => s.config);
  const liveNodeId = useAgentStore((s) => s.liveWorkflowNodeId);
  const inFlight = useAgentStore((s) => s.inFlight);
  const workflow = config?.workflow;

  const laid = useMemo(() => {
    if (!workflow) return null;
    return layout(workflow.nodes, workflow.edges);
  }, [workflow]);

  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-select the node Alta is currently animating, falls back to start.
  useEffect(() => {
    if (!workflow) return;
    if (selectedId && workflow.nodes.some((n) => n.id === selectedId)) return;
    if (liveNodeId) setSelectedId(liveNodeId);
    else setSelectedId(workflow.nodes[0]?.id ?? null);
  }, [workflow, liveNodeId, selectedId]);

  if (!workflow || !laid) return null;

  return (
    <div className="grid h-full grid-rows-[auto_1fr] bg-(--color-panel-sunken)">
      {/* Toolbar */}
      <div className="vb-flow-toolbar">
        <span className="vb-flow-title">Conversation workflow</span>
        <span className="vb-flow-meta">
          {workflow.nodes.length} nodes · {workflow.edges.length} edges
        </span>
        <span style={{ flex: 1 }} />
        <div className="vb-flow-legend hidden md:flex">
          {LEGEND.map((l) => (
            <span key={l.kind}>
              <i style={{ background: l.color }} /> {l.label}
            </span>
          ))}
        </div>
        <span className="vb-flow-sep" />
        <button
          className="vb-flow-iconbtn"
          title="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
        >
          −
        </button>
        <span className="vb-flow-zoom">{Math.round(zoom * 100)}%</span>
        <button
          className="vb-flow-iconbtn"
          title="Zoom in"
          onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}
        >
          +
        </button>
        <button
          className="vb-flow-iconbtn"
          title="Fit"
          onClick={() => setZoom(1)}
        >
          ⛶
        </button>
        {inFlight.has("workflow") && (
          <>
            <span className="vb-flow-sep" />
            <span className="font-mono text-[10px] tracking-widest text-(--color-violet-600)">
              BUILDING…
            </span>
          </>
        )}
      </div>

      {/* Canvas */}
      <div className="vb-flow-canvas">
        {workflow.nodes.length <= 1 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-(--color-muted)">
            Workflow will appear once Alta drafts it. Try “Sketch a workflow for
            triaging support calls.”
          </div>
        ) : (
          <div
            style={{
              width: laid.width * zoom,
              height: laid.height * zoom,
              position: "relative",
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
              transform: `scale(${zoom})`,
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
                      <text
                        x={midX}
                        y={(y1 + y2) / 2 - 6}
                        fontSize={10}
                        fill="var(--color-muted)"
                        fontFamily="var(--font-mono)"
                      >
                        {e.label}
                      </text>
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
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelectedId(n.id)}
                  className={`vb-node ${isSel ? "selected" : ""} ${
                    isLive ? "lit-now" : ""
                  }`}
                  style={{
                    position: "absolute",
                    left: p.x,
                    top: p.y,
                    width: NODE_W,
                    textAlign: "left",
                  }}
                >
                  <div className={`kind ${n.type}`}>
                    <i />
                    {TYPE_LABEL[n.type]}
                  </div>
                  <div className="label">{n.label}</div>
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

