"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Lightweight character-by-character text reveal. Returns a plain string
 * so callers keep full control over the surrounding markup (mono fonts,
 * line-clamp, dir="auto", etc.). Calls `onDone()` exactly once when the
 * full text has been revealed (useful for chaining animations).
 */
export function useTypewriter(
  text: string,
  enabled: boolean,
  cps = 55,
  onDone?: () => void,
) {
  const [shown, setShown] = useState(enabled ? 0 : text.length);
  const doneRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setShown(text.length);
      return;
    }
    doneRef.current = false;
    setShown(0);
    let cancelled = false;
    let i = 0;
    const stepMs = Math.max(8, Math.floor(1000 / cps));
    let timer = 0;
    const tick = () => {
      if (cancelled) return;
      i++;
      setShown(i);
      if (i < text.length) {
        timer = window.setTimeout(tick, stepMs);
      } else if (!doneRef.current) {
        doneRef.current = true;
        onDone?.();
      }
    };
    timer = window.setTimeout(tick, stepMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [text, enabled, cps, onDone]);

  return shown >= text.length ? text : text.slice(0, shown);
}
