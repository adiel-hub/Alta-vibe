"use client";

import { useEffect, useRef, useState } from "react";

// ── Typewriter (agent lines reveal char-by-char as if being typed) ──────

export function TypewriterText({
  text,
  onTick,
  speedMs = 18,
}: {
  text: string;
  onTick?: () => void;
  speedMs?: number;
}) {
  const [count, setCount] = useState(0);
  const onTickRef = useRef(onTick);
  useEffect(() => {
    onTickRef.current = onTick;
  }, [onTick]);

  useEffect(() => {
    setCount(0);
    if (!text) return;
    let i = 0;
    const id = window.setInterval(() => {
      i = Math.min(i + 1, text.length);
      setCount(i);
      onTickRef.current?.();
      if (i >= text.length) window.clearInterval(id);
    }, speedMs);
    return () => window.clearInterval(id);
  }, [text, speedMs]);

  return <span dir="auto">{text.slice(0, count)}</span>;
}
