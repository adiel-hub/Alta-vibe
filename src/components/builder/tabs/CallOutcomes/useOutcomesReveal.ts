"use client";

import { useEffect, useRef, useState } from "react";
import type { EvaluationCriterion } from "@/types/agent";
import { useAgentStore } from "@/store/agentStore";

const STAGGER_MS = 450;

/**
 * Drives the typewriter reveal of agent-created call outcomes (evaluation
 * criteria). Mirrors {@link import("./useKnowledgeReveal").useKnowledgeReveal}
 * — the source of truth is `evalPendingAnimationIds` in the global store,
 * populated by `applyPatch` when the agent's tool patch contains a newly-
 * created criterion id. The set survives tab unmount/remount, so the
 * animation plays exactly once even if the user wasn't on the tab when
 * the outcome was created.
 *
 * Returns:
 *   isRevealed(id) — whether the row should be in the list yet.
 *   isTyping(id)   — whether the row should typewriter its name + prompt.
 */
export function useOutcomesReveal(outcomes: EvaluationCriterion[]) {
  const pendingIds = useAgentStore((s) => s.evalPendingAnimationIds);

  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const o of outcomes) if (!pendingIds.has(o.id)) initial.add(o.id);
    return initial;
  });
  const [typingIds, setTypingIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<number[]>([]);
  const scheduledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const ids = new Set(outcomes.map((o) => o.id));
    setRevealedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const o of outcomes) {
        if (!pendingIds.has(o.id) && !next.has(o.id)) {
          next.add(o.id);
          changed = true;
        }
      }
      for (const id of next) {
        if (!ids.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const toSchedule: string[] = [];
    for (const o of outcomes) {
      if (!pendingIds.has(o.id)) continue;
      if (scheduledRef.current.has(o.id)) continue;
      toSchedule.push(o.id);
    }
    if (toSchedule.length === 0) return;

    toSchedule.forEach((id, i) => {
      scheduledRef.current.add(id);
      const t = window.setTimeout(() => {
        setRevealedIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
        setTypingIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      }, i * STAGGER_MS);
      timersRef.current.push(t);
    });

    return () => {
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };
  }, [outcomes, pendingIds]);

  return {
    isRevealed: (id: string) => revealedIds.has(id),
    isTyping: (id: string) => typingIds.has(id),
  };
}
