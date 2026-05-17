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

  const selected = workflow.nodes.find((n) => n.id === selectedId) ?? null;
  const outgoing = workflow.edges.filter((e) => e.from === selectedId);
  const incoming = workflow.edges.filter((e) => e.to === selectedId);

  const nodeById = new Map(workflow.nodes.map((n) => [n.id, n]));

  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto] bg-(--color-panel-sunken)">
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
                      <text
                        x={(x1 + x2) / 2 + 8}
                        y={midY}
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

      {/* Inspector */}
      <div className="vb-flow-inspector">
        {selected ? (
          <>
            <div className="vb-flow-inspector-head">
              <span className="vb-flow-inspector-title">{selected.label}</span>
              <span className={`vb-flow-inspector-kind`}>
                <i
                  style={{
                    background:
                      LEGEND.find((l) => l.kind === selected.type)?.color ??
                      "var(--color-muted)",
                  }}
                />
                {TYPE_LABEL[selected.type]}
              </span>
              <span className="ml-auto font-mono text-[10px] tracking-widest text-(--color-muted-soft)">
                {selected.id}
              </span>
            </div>
            <div className="vb-flow-inspector-body">
              <NodeDataView node={selected} />
              <div className="vb-field-grid mt-2">
                <div className="vb-field">
                  <div className="vb-field-label">Outgoing</div>
                  <div className="vb-pill-list">
                    {outgoing.length === 0 && (
                      <span className="vb-field-hint">No outgoing edges.</span>
                    )}
                    {outgoing.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => setSelectedId(e.to)}
                        className="vb-pill"
                      >
                        → {nodeById.get(e.to)?.label ?? e.to}
                        {e.label ? ` · ${e.label}` : ""}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="vb-field">
                  <div className="vb-field-label">Incoming</div>
                  <div className="vb-pill-list">
                    {incoming.length === 0 && (
                      <span className="vb-field-hint">No incoming edges.</span>
                    )}
                    {incoming.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => setSelectedId(e.from)}
                        className="vb-pill"
                      >
                        ← {nodeById.get(e.from)?.label ?? e.from}
                        {e.label ? ` · ${e.label}` : ""}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="vb-flow-inspector-body text-(--color-muted)">
            Select a node to inspect it.
          </div>
        )}
      </div>
    </div>
  );
}

function NodeDataView({ node }: { node: WorkflowNode }) {
  const data = node.data ?? {};
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return (
      <p className="vb-field-hint">
        No data fields on this node — it’s a control point in the graph.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {entries.map(([k, v]) => (
        <div key={k} className="vb-field">
          <div className="vb-field-label">{k}</div>
          {typeof v === "string" ? (
            <div className="vb-field-input vb-field-textarea" style={{ minHeight: 0 }}>
              {v}
            </div>
          ) : (
            <pre className="vb-field-input font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {JSON.stringify(v, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
