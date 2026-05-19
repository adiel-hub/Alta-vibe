"use client";

import { useEffect, useRef, useState } from "react";
import type { KnowledgeBaseDocument } from "@/types/agent";
import { useAgentStore } from "@/store/agentStore";

const STAGGER_MS = 550;

/**
 * Drives the typewriter reveal of agent-created KB documents.
 *
 * The source of truth is `kbPendingAnimationIds` in the global store: a
 * patch diff marks a doc id "pending animation" the moment its tool result
 * lands. The set survives tab unmount/remount, so opening the KB section
 * after the agent created docs while you were elsewhere still plays the
 * animation once — and only once. Plain hydrate (initial page load, agent
 * switch) leaves the set empty, so existing docs render statically.
 *
 * Returns:
 *   isRevealed(id) — whether the card should be in the grid yet.
 *   isTyping(id)   — whether the card should typewriter its title /
 *                    source / content (only docs the agent just created).
 */
export function useKnowledgeReveal(docs: KnowledgeBaseDocument[]) {
  const pendingIds = useAgentStore((s) => s.kbPendingAnimationIds);

  // Docs not pending animation are revealed immediately. The pending ones
  // wait their turn via a staggered timer chain.
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const d of docs) if (!pendingIds.has(d.id)) initial.add(d.id);
    return initial;
  });
  const [typingIds, setTypingIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<number[]>([]);
  const scheduledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Make sure every non-pending doc is revealed instantly. Without this
    // step, docs added then animation-completed wouldn't reappear after a
    // remount (we'd miss the initialiser's pre-set).
    const docIds = new Set(docs.map((d) => d.id));
    setRevealedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const d of docs) {
        if (!pendingIds.has(d.id) && !next.has(d.id)) {
          next.add(d.id);
          changed = true;
        }
      }
      for (const id of next) {
        if (!docIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // Schedule reveals for any pending doc we haven't already scheduled.
    const toSchedule: string[] = [];
    for (const d of docs) {
      if (!pendingIds.has(d.id)) continue;
      if (scheduledRef.current.has(d.id)) continue;
      toSchedule.push(d.id);
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
  }, [docs, pendingIds]);

  return {
    isRevealed: (id: string) => revealedIds.has(id),
    isTyping: (id: string) => typingIds.has(id),
  };
}
