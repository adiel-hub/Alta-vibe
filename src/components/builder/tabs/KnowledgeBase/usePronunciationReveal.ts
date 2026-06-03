"use client";

import { useEffect, useRef, useState } from "react";
import type { PronunciationRule } from "@/types/agent";
import { useAgentStore } from "@/store/agentStore";

const STAGGER_MS = 420;

/**
 * Drives the typewriter reveal of agent-created pronunciation rules. Mirror of
 * `useKnowledgeReveal` keyed on rule ids and reading `pronPendingAnimationIds`.
 *
 * Returns:
 *   isRevealed(id) — whether the card should be in the grid yet.
 *   isTyping(id)   — whether the card should typewriter its word / pronunciation.
 */
export function usePronunciationReveal(rules: PronunciationRule[]) {
  const pendingIds = useAgentStore((s) => s.pronPendingAnimationIds);

  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const r of rules) if (!pendingIds.has(r.id)) initial.add(r.id);
    return initial;
  });
  const [typingIds, setTypingIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<number[]>([]);
  const scheduledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const ruleIds = new Set(rules.map((r) => r.id));
    setRevealedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const r of rules) {
        if (!pendingIds.has(r.id) && !next.has(r.id)) {
          next.add(r.id);
          changed = true;
        }
      }
      for (const id of next) {
        if (!ruleIds.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    const toSchedule: string[] = [];
    for (const r of rules) {
      if (!pendingIds.has(r.id)) continue;
      if (scheduledRef.current.has(r.id)) continue;
      toSchedule.push(r.id);
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
  }, [rules, pendingIds]);

  // Unmount-only cleanup (see useKnowledgeReveal for the rationale).
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
