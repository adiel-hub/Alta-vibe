"use client";

import { useEffect, useRef, useState } from "react";
import type { DataCollectionField } from "@/types/agent";
import { useAgentStore } from "@/store/agentStore";

const STAGGER_MS = 450;

/**
 * Drives the typewriter reveal of newly-added data-extraction fields.
 * Mirrors {@link import("./useOutcomesReveal").useOutcomesReveal} — the
 * source of truth is `dataPendingAnimationIds` in the global store,
 * populated by `applyPatch` / `applyConfigDirect` when a patch carries
 * a previously-unseen field id. The set survives tab unmount/remount,
 * so the animation plays exactly once even if the user wasn't on the
 * tab when the field was added.
 */
export function useDataExtractionReveal(fields: DataCollectionField[]) {
  const pendingIds = useAgentStore((s) => s.dataPendingAnimationIds);

  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const f of fields) if (!pendingIds.has(f.id)) initial.add(f.id);
    return initial;
  });
  const [typingIds, setTypingIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<number[]>([]);
  const scheduledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const ids = new Set(fields.map((f) => f.id));
    setRevealedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const f of fields) {
        if (!pendingIds.has(f.id) && !next.has(f.id)) {
          next.add(f.id);
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
    for (const f of fields) {
      if (!pendingIds.has(f.id)) continue;
      if (scheduledRef.current.has(f.id)) continue;
      toSchedule.push(f.id);
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
  }, [fields, pendingIds]);

  // Unmount-only cleanup. We intentionally do NOT cancel timers on rerun:
  // doing so would orphan any id whose timer was cancelled mid-stagger
  // (it stays in `scheduledRef` and is never re-scheduled), permanently
  // dropping that field. Letting timers fire across reruns is safe because
  // `scheduledRef` dedupes scheduling and the callbacks are idempotent.
  useEffect(() => {
    return () => {
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current = [];
    };
  }, []);

  return {
    isRevealed: (id: string) => revealedIds.has(id),
    isTyping: (id: string) => typingIds.has(id),
  };
}
