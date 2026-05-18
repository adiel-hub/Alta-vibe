"use client";

import { useEffect, useRef, useState } from "react";
import { MarkdownText } from "./MarkdownText";

/**
 * Smoothed character-by-character reveal. Buffers the supplied text and
 * reveals it at a controlled rate so chunky network deltas appear as a
 * uniform typing animation. The revealed slice is run through
 * MarkdownText so **bold**, `code`, bullet lists, etc. format
 * progressively as the agent streams. When `live` is false (the
 * streaming turn is done) the remaining buffer flushes instantly.
 */
export function Typewriter({
  text,
  live,
  cps = 90,
  className,
}: {
  text: string;
  live: boolean;
  /** Characters per second. */
  cps?: number;
  className?: string;
}) {
  const [shown, setShown] = useState(0);
  const lastTextRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  // If text is replaced or truncated, snap back.
  useEffect(() => {
    if (!text.startsWith(lastTextRef.current)) {
      setShown(0);
    }
    lastTextRef.current = text;
  }, [text]);

  // Flush instantly when streaming ends.
  useEffect(() => {
    if (!live) setShown(text.length);
  }, [live, text.length]);

  useEffect(() => {
    if (!live) return;
    if (shown >= text.length) return;

    const tick = (now: number) => {
      if (lastTickRef.current == null) lastTickRef.current = now;
      const dt = now - lastTickRef.current;
      const advance = Math.max(1, Math.floor((dt / 1000) * cps));
      // If we're way behind (long pause then big delta), accelerate.
      const gap = text.length - shown;
      const speedup = gap > 80 ? Math.ceil(gap / 40) : 1;
      const next = Math.min(text.length, shown + advance * speedup);
      lastTickRef.current = now;
      setShown(next);
      if (next < text.length) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
    };
  }, [text, shown, live, cps]);

  const showCursor = live && shown < text.length;
  const cursor = showCursor ? (
    <span className="ml-[1px] inline-block h-[1em] w-[2px] translate-y-[2px] animate-cursor bg-current align-baseline" />
  ) : null;

  return (
    <MarkdownText
      text={text.slice(0, shown)}
      cursor={cursor}
      className={className}
    />
  );
}
