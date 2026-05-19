import type { WorkflowEdge, WorkflowNode } from "@/types/agent";
import {
  COL_GAP,
  NODE_H,
  NODE_W,
  PADDING,
  ROW_GAP,
} from "./_shared/constants";
import { log } from "./_shared/logger";

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
export function layout(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
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
