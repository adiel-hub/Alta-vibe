"use client";

import { Fragment, useMemo, type ReactNode } from "react";

/**
 * Lightweight markdown renderer for chat messages. Handles the subset the
 * builder agent actually emits: paragraphs, blank-line splits, bullet
 * lists (`- ` / `* `), numbered lists (`1. `), inline **bold**, *italic*,
 * `inline code`, and bare http(s) URLs.
 *
 * Intentionally NOT a full CommonMark — keeping the surface tiny avoids
 * surprises during the live typewriter reveal (a partial `**bold` token
 * just stays literal until the closing `**` arrives, which reads fine).
 */
export function MarkdownText({
  text,
  cursor,
  className,
}: {
  text: string;
  /** Optional cursor element appended to the last block (live typewriter). */
  cursor?: ReactNode;
  className?: string;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (blocks.length === 0) {
    // Empty text — still render cursor if requested so the caret has a home.
    return cursor ? <p className={className}>{cursor}</p> : null;
  }
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        const isLast = i === blocks.length - 1;
        return renderBlock(b, i, isLast ? cursor : null);
      })}
    </div>
  );
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  let ul: string[] | null = null;
  let ol: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push({ kind: "p", text: para.join("\n") });
      para = [];
    }
  };
  const flushUl = () => {
    if (ul) {
      out.push({ kind: "ul", items: ul });
      ul = null;
    }
  };
  const flushOl = () => {
    if (ol) {
      out.push({ kind: "ol", items: ol });
      ol = null;
    }
  };

  for (const raw of lines) {
    const hMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(raw);
    const ulMatch = /^\s*[-*]\s+(.+)$/.exec(raw);
    const olMatch = /^\s*\d+\.\s+(.+)$/.exec(raw);
    if (hMatch) {
      flushPara();
      flushUl();
      flushOl();
      out.push({ kind: "h", level: hMatch[1].length, text: hMatch[2] });
      continue;
    }
    if (ulMatch) {
      flushPara();
      flushOl();
      ul ??= [];
      ul.push(ulMatch[1]);
      continue;
    }
    if (olMatch) {
      flushPara();
      flushUl();
      ol ??= [];
      ol.push(olMatch[1]);
      continue;
    }
    if (!raw.trim()) {
      flushPara();
      flushUl();
      flushOl();
      continue;
    }
    flushUl();
    flushOl();
    para.push(raw);
  }
  flushPara();
  flushUl();
  flushOl();
  return out;
}

// Heading sizing by ATX level. `#`/`##` read as section titles; deeper
// levels taper toward body weight so a prompt's outline stays scannable
// without any single heading shouting.
const HEADING_CLASS: Record<number, string> = {
  1: "text-[15px] font-semibold",
  2: "text-[14px] font-semibold",
  3: "text-[13px] font-semibold",
  4: "text-[13px] font-medium",
  5: "text-[13px] font-medium",
  6: "text-[13px] font-medium",
};

function renderBlock(b: Block, key: number, cursor: ReactNode | null): ReactNode {
  if (b.kind === "p") {
    return (
      <p key={key} className="whitespace-pre-wrap leading-relaxed">
        {renderInline(b.text)}
        {cursor}
      </p>
    );
  }
  if (b.kind === "h") {
    const cls = HEADING_CLASS[b.level] ?? HEADING_CLASS[6];
    return (
      <p
        key={key}
        className={`${cls} mt-3 mb-1 leading-snug text-(--color-foreground-strong) first:mt-0`}
      >
        {renderInline(b.text)}
        {cursor}
      </p>
    );
  }
  if (b.kind === "ul") {
    return (
      <ul key={key} className="list-disc space-y-1.5 pl-5 leading-relaxed">
        {b.items.map((it, j) => {
          const last = j === b.items.length - 1;
          return (
            <li key={j}>
              {renderInline(it)}
              {last ? cursor : null}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ol key={key} className="list-decimal space-y-1.5 pl-5 leading-relaxed">
      {b.items.map((it, j) => {
        const last = j === b.items.length - 1;
        return (
          <li key={j}>
            {renderInline(it)}
            {last ? cursor : null}
          </li>
        );
      })}
    </ol>
  );
}

// One regex pass over the line. Tokenises **bold**, *italic*, `code`, and
// bare http(s) URLs; everything else is literal text.
const INLINE_RE =
  /(\*\*[^*\n]+?\*\*|`[^`\n]+?`|\*[^*\n\s][^*\n]*?\*|https?:\/\/[^\s<>()]+)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      out.push(<Fragment key={`t${key++}`}>{text.slice(lastIdx, m.index)}</Fragment>);
    }
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(
        <strong
          key={`b${key++}`}
          className="font-semibold text-(--color-foreground-strong)"
        >
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <code
          key={`c${key++}`}
          className="rounded-md bg-(--color-panel-soft) px-[5px] py-[1px] font-mono text-[12px] text-(--color-foreground-strong)"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("*")) {
      out.push(
        <em key={`i${key++}`} className="italic">
          {tok.slice(1, -1)}
        </em>,
      );
    } else if (tok.startsWith("http")) {
      out.push(
        <a
          key={`a${key++}`}
          href={tok}
          target="_blank"
          rel="noreferrer"
          className="text-(--color-accent) underline-offset-2 hover:underline"
        >
          {tok}
        </a>,
      );
    }
    lastIdx = INLINE_RE.lastIndex;
  }
  if (lastIdx < text.length) {
    out.push(<Fragment key={`t${key++}`}>{text.slice(lastIdx)}</Fragment>);
  }
  return out;
}
