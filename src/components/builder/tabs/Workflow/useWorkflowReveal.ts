"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkflowEdge, WorkflowNode, WorkflowState } from "@/types/agent";
import { createClientLogger } from "@/lib/clientLogger";

const STAGGER_MS = 90;
const log = createClientLogger("workflow:reveal");

/**
 * Reveals newly-added workflow nodes and edges one-by-one in BFS order from
 * `start`, instead of slamming the whole graph onto the canvas at once.
 *
 * The patch from `set_workflow` contains the entire graph, which on a busy
 * frame collides with the chat typewriter and stalls the main thread. By
 * staggering visibility across ~`nodes.length * STAGGER_MS` ms we (a) make
 * the build feel alive — like Alta is drawing it as she speaks — and (b)
 * spread DOM/SVG paint across many frames so each one stays under budget.
 *
 * Nodes that were already on screen stay visible immediately — only the
 * *new* nodes animate in. Edges become visible once both endpoints are.
 *
 * If a fresh workflow arrives mid-reveal we don't un-show anything; we just
 * diff against the currently-visible set and continue.
 */
export function useWorkflowReveal(workflow: WorkflowState | undefined) {
  const [visibleNodeIds, setVisibleNodeIds] = useState<Set<string>>(new Set());
  const [isBuilding, setIsBuilding] = useState(false);
  const timersRef = useRef<number[]>([]);
  // First mount with a workflow already present = page hydrate after a
  // reload. Skip the staggered reveal in that case — the user didn't ask
  // for it. Only patches that arrive after first render should animate.
  const didHydrateRef = useRef(false);

  useEffect(() => {
    const cancelled = timersRef.current.length;
    // Cancel any in-flight reveal — we'll restart it against the new graph.
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];

    if (!workflow) {
      log.debug("effect: no workflow → reset", { cancelled_timers: cancelled });
      setVisibleNodeIds(new Set());
      setIsBuilding(false);
      return;
    }

    if (!didHydrateRef.current) {
      didHydrateRef.current = true;
      log.info("effect: first hydrate, reveal-all instantly", {
        nodes: workflow.nodes.length,
        edges: workflow.edges.length,
      });
      setVisibleNodeIds(new Set(workflow.nodes.map((n) => n.id)));
      setIsBuilding(false);
      return;
    }

    const tOrder0 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const order = bfsOrder(workflow.nodes, workflow.edges);
    const tOrder1 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const currentlyVisible = visibleNodeIds;
    const toReveal = order.filter((id) => !currentlyVisible.has(id));
    const stillExisting = order.filter((id) => currentlyVisible.has(id));
    log.debug("effect: diff computed", {
      order_n: order.length,
      bfs_ms: Math.round((tOrder1 - tOrder0) * 100) / 100,
      currently_visible: currentlyVisible.size,
      to_reveal: toReveal.length,
      still_existing: stillExisting.length,
      cancelled_timers: cancelled,
    });

    if (toReveal.length === 0) {
      // Workflow shrank or only metadata changed — just prune ids that no
      // longer exist so the visible set stays correct.
      const allIds = new Set(workflow.nodes.map((n) => n.id));
      if ([...currentlyVisible].some((id) => !allIds.has(id))) {
        log.debug("effect: pruning stale ids", {
          before: currentlyVisible.size,
          after: stillExisting.length,
        });
        setVisibleNodeIds(new Set(stillExisting));
      }
      setIsBuilding(false);
      return;
    }

    // First mount / hydrate path: if nothing was visible before, reveal the
    // first node instantly so the canvas isn't blank for 90ms, then stagger
    // the rest.
    const baseVisible = new Set(stillExisting);
    if (currentlyVisible.size === 0 && toReveal.length > 0) {
      baseVisible.add(toReveal[0]);
    }
    setVisibleNodeIds(baseVisible);
    setIsBuilding(true);

    const queue =
      currentlyVisible.size === 0 ? toReveal.slice(1) : toReveal;
    log.info("effect: scheduling reveal", {
      to_reveal: queue.length,
      stagger_ms: STAGGER_MS,
      total_ms: queue.length * STAGGER_MS,
    });

    const scheduleT0 =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    queue.forEach((id, i) => {
      const t = window.setTimeout(() => {
        const fireT =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        setVisibleNodeIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        if (i === queue.length - 1) {
          log.info("effect: reveal complete", {
            elapsed_ms: Math.round((fireT - scheduleT0) * 100) / 100,
            revealed: queue.length,
          });
          setIsBuilding(false);
        } else {
          log.trace("tick: reveal", {
            idx: i,
            id,
            elapsed_ms: Math.round((fireT - scheduleT0) * 100) / 100,
          });
        }
      }, (i + 1) * STAGGER_MS);
      timersRef.current.push(t);
    });

    return () => {
      const left = timersRef.current.length;
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
      if (left > 0) log.trace("cleanup: cleared timers", { cleared: left });
    };
    // We intentionally only re-run when the workflow reference changes —
    // visibleNodeIds is *read* via closure but should not retrigger the
    // schedule, otherwise every setVisibleNodeIds would cancel the chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow]);

  // Edges are visible iff both endpoints are visible. Derived during render
  // — cheap, and avoids a second state update per node reveal.
  const visibleEdgeIds = workflow
    ? new Set(
        workflow.edges
          .filter(
            (e) => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to),
          )
          .map((e) => e.id),
      )
    : new Set<string>();

  return { visibleNodeIds, visibleEdgeIds, isBuilding };
}

/**
 * BFS from the `start` node, falling back to any other unreached roots so
 * orphans still get revealed in a sensible order.
 */
function bfsOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e.to);
    outgoing.set(e.from, list);
  }

  const visit = (rootId: string) => {
    const q = [rootId];
    while (q.length) {
      const id = q.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const next of outgoing.get(id) ?? []) {
        if (!seen.has(next)) q.push(next);
      }
    }
  };

  if (nodes.some((n) => n.id === "start")) visit("start");
  for (const n of nodes) if (!seen.has(n.id)) visit(n.id);
  return out;
}
