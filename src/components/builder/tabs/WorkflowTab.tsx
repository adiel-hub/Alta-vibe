"use client";

import { useMemo } from "react";
import { useAgentStore } from "@/store/agentStore";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "@/types/agent";

const NODE_W = 180;
const NODE_H = 64;
const COL_GAP = 80;
const ROW_GAP = 40;
const PADDING = 24;

const TYPE_STYLE: Record<WorkflowNodeType, { icon: string; color: string }> = {
  start: { icon: "▶", color: "var(--color-success)" },
  speak: { icon: "🔊", color: "var(--color-accent)" },
  collect: { icon: "📥", color: "var(--color-accent)" },
  tool_call: { icon: "🛠", color: "#9aa7ff" },
  condition: { icon: "❖", color: "#f0c674" },
  transfer: { icon: "↪", color: "#cc8" },
  end: { icon: "■", color: "var(--color-danger)" },
};

/**
 * Topological-ish layered layout: BFS from the start node, placing each
 * node in the column corresponding to its depth. Multiple nodes in a layer
 * stack vertically. Cycles fall through to the next available position.
 */
function layout(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) {
    if (byId.has(e.to)) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  // BFS starting from nodes with no incoming, or 'start' first.
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

  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const col = columns.get(d) ?? [];
    col.push(n.id);
    columns.set(d, col);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [col, ids] of columns) {
    ids.forEach((id, row) => {
      positions.set(id, {
        x: PADDING + col * (NODE_W + COL_GAP),
        y: PADDING + row * (NODE_H + ROW_GAP),
      });
    });
  }

  const maxCol = Math.max(0, ...Array.from(columns.keys()));
  const maxRow = Math.max(
    0,
    ...Array.from(columns.values()).map((arr) => arr.length - 1),
  );
  const width = PADDING * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP;
  const height = PADDING * 2 + (maxRow + 1) * NODE_H + maxRow * ROW_GAP;
  return { positions, width, height };
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

  if (!workflow || !laid) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          Conversation workflow
        </h3>
        {inFlight.has("workflow") && (
          <span className="text-xs text-(--color-accent)">building…</span>
        )}
      </div>
      <p className="text-xs text-(--color-muted)">
        Built automatically as you describe the agent. During a test call, the
        active node highlights live.
      </p>
      {workflow.nodes.length <= 1 ? (
        <div className="rounded-2xl border border-dashed border-(--color-border) p-6 text-center text-sm text-(--color-muted)">
          Ask in chat: <span className="italic">&quot;Sketch a workflow for triaging
          incoming support calls.&quot;</span>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-(--color-border) bg-(--color-panel) p-3">
          <svg
            width={Math.max(laid.width, 360)}
            height={Math.max(laid.height, 120)}
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {/* Edges */}
            <g className="text-(--color-muted)">
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
                return (
                  <g key={e.id}>
                    <path
                      d={path}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      markerEnd="url(#arrow)"
                    />
                    {e.label && (
                      <text
                        x={midX}
                        y={(y1 + y2) / 2 - 4}
                        textAnchor="middle"
                        fontSize={10}
                        fill="currentColor"
                      >
                        {e.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
            {/* Nodes */}
            {workflow.nodes.map((n) => {
              const p = laid.positions.get(n.id);
              if (!p) return null;
              const style = TYPE_STYLE[n.type];
              const isLive = liveNodeId === n.id;
              return (
                <g key={n.id} transform={`translate(${p.x}, ${p.y})`}>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={12}
                    ry={12}
                    fill={isLive ? "var(--color-accent)" : "var(--color-panel-soft)"}
                    stroke={isLive ? "var(--color-accent)" : style.color}
                    strokeWidth={isLive ? 2 : 1}
                  />
                  <text
                    x={12}
                    y={20}
                    fontSize={11}
                    fontWeight={600}
                    fill={isLive ? "var(--color-accent-foreground)" : style.color}
                  >
                    {style.icon} {n.type}
                  </text>
                  <text
                    x={12}
                    y={40}
                    fontSize={13}
                    fill={isLive ? "var(--color-accent-foreground)" : "var(--color-foreground)"}
                  >
                    {truncate(n.label, 22)}
                  </text>
                  <text
                    x={12}
                    y={56}
                    fontSize={10}
                    fill={isLive ? "var(--color-accent-foreground)" : "var(--color-muted)"}
                  >
                    {n.id}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {liveNodeId && (
        <div className="rounded-lg bg-(--color-accent)/15 px-3 py-2 text-xs text-(--color-accent)">
          Live test call is in node:{" "}
          <span className="font-mono">{liveNodeId}</span>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
