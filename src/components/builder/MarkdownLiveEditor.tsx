"use client";

import { useEffect, useRef } from "react";

/**
 * Single in-place markdown editor — the editor *is* the rendered view.
 *
 * The user types raw markdown and sees it formatted live, in the same box,
 * with no separate preview pane and no edit/preview toggle. Headings, bullets,
 * `**bold**`, `*italic*`, and `code` style as you type.
 *
 * Design: the markdown markers (`#`, `**`, `-`) are KEPT in the text but
 * dimmed, and the surrounding content is styled. That makes the editor's
 * text content byte-identical to the markdown string, so `serialize()` is
 * trivial and save round-trips losslessly — sidestepping the hard part of a
 * WYSIWYG editor (turning rendered DOM back into markdown).
 *
 * Mechanism: we own the DOM imperatively (no React children). On every input
 * we read the text back out (`serialize`), repaint our clean formatted
 * structure, and restore the caret by character offset — robust across the
 * font-size/weight changes that an overlay-on-textarea approach can't survive.
 */
export function MarkdownLiveEditor({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
  onBlur,
  fill,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
  /** Stretch to fill the parent flex column (matches the textarea's fill
   *  mode). The parent Section must be a flex column. */
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The markdown the DOM currently reflects. Lets the value-sync effect skip
  // the repaint that would otherwise fire from our own onChange.
  const valueRef = useRef(value);
  const caretRef = useRef(0);
  const isComposing = useRef(false);
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const lastInputType = useRef<string>("");
  const lastEditAt = useRef(0);

  // Rebuild the formatted DOM from a markdown string and (optionally) place
  // the caret at a character offset into that text.
  const paint = (text: string, caret: number | null) => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(...buildDom(text));
    valueRef.current = text;
    if (caret != null) {
      const clamped = Math.max(0, Math.min(caret, text.length));
      setCaret(el, clamped);
      caretRef.current = clamped;
    }
  };

  const emit = (text: string) => {
    valueRef.current = text;
    onChange(text);
  };

  // Mount: paint initial value once.
  useEffect(() => {
    paint(value, null);
    if (autoFocus && ref.current) {
      ref.current.focus();
      setCaret(ref.current, value.length);
      caretRef.current = value.length;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (e.g. Revert restoring the saved value, or Alta
  // rewriting the prompt). Skipped when the change came from our own onInput,
  // since by then valueRef already equals the incoming value.
  useEffect(() => {
    if (value === valueRef.current) return;
    const focused = document.activeElement === ref.current;
    paint(value, focused ? caretRef.current : null);
  }, [value]);

  const onInput = (e: React.FormEvent<HTMLDivElement>) => {
    if (isComposing.current) return;
    const el = ref.current;
    if (!el) return;
    const inputType = (e.nativeEvent as InputEvent).inputType ?? "";
    const md = serialize(el);
    const caret = currentOffset(el) ?? md.length;
    pushUndo(valueRef.current, caretRef.current, inputType);
    paint(md, caret);
    emit(md);
  };

  // The browser's native undo/redo operates on a contentEditable history that
  // our innerHTML repaints have invalidated — so intercept it and drive our
  // own snapshot stack instead.
  const onBeforeInput = (e: React.FormEvent<HTMLDivElement>) => {
    const inputType = (e.nativeEvent as InputEvent).inputType;
    if (inputType === "historyUndo") {
      e.preventDefault();
      applyHistory(undoStack, redoStack);
    } else if (inputType === "historyRedo") {
      e.preventDefault();
      applyHistory(redoStack, undoStack);
    }
  };

  const applyHistory = (
    from: React.RefObject<Snapshot[]>,
    to: React.RefObject<Snapshot[]>,
  ) => {
    const snap = from.current.pop();
    if (!snap) return;
    to.current.push({ text: valueRef.current, caret: caretRef.current });
    paint(snap.text, snap.caret);
    emit(snap.text);
  };

  const pushUndo = (text: string, caret: number, inputType: string) => {
    const now = Date.now();
    // Coalesce a run of single-char typing into one undo step: only snapshot
    // the state *before* the run begins.
    const coalesce =
      inputType === "insertText" &&
      lastInputType.current === "insertText" &&
      now - lastEditAt.current < 600;
    if (!coalesce) {
      undoStack.current.push({ text, caret });
      if (undoStack.current.length > 200) undoStack.current.shift();
      redoStack.current = [];
    }
    lastInputType.current = inputType;
    lastEditAt.current = now;
  };

  const showPlaceholder = value.length === 0 && !!placeholder;

  return (
    <div className={`relative ${fill ? "flex min-h-0 flex-1 flex-col" : ""}`}>
      {showPlaceholder && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 px-[10px] py-[8px] text-(--color-muted-soft)"
        >
          {placeholder}
        </div>
      )}
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label="System prompt"
        contentEditable
        suppressContentEditableWarning
        dir="auto"
        spellCheck
        onInput={onInput}
        onBeforeInput={onBeforeInput}
        onCompositionStart={() => {
          isComposing.current = true;
        }}
        onCompositionEnd={() => {
          isComposing.current = false;
          const el = ref.current;
          if (!el) return;
          const md = serialize(el);
          const caret = currentOffset(el) ?? md.length;
          paint(md, caret);
          emit(md);
        }}
        onBlur={onBlur}
        className={`whitespace-pre-wrap break-words outline-none ${className ?? ""}`}
      />
    </div>
  );
}

type Snapshot = { text: string; caret: number };

/* ---------------------------------------------------------------------------
 * Rendering: markdown string -> formatted DOM nodes (one block per line).
 *
 * Marker characters are preserved as dimmed spans so the concatenated text
 * content equals the source markdown exactly.
 * ------------------------------------------------------------------------- */

const HEADING_CLASS: Record<number, string> = {
  1: "text-[15px] font-semibold leading-snug",
  2: "text-[14px] font-semibold leading-snug",
  3: "text-[13px] font-semibold leading-snug",
  4: "text-[13px] font-medium",
  5: "text-[13px] font-medium",
  6: "text-[13px] font-medium",
};

const MARKER_CLASS = "text-(--color-muted-soft)";

function buildDom(text: string): HTMLElement[] {
  // Line-based: every source line is one block element. This keeps caret math
  // and serialization unambiguous (newline == block boundary).
  return text.split("\n").map((line) => buildLine(line));
}

function buildLine(line: string): HTMLElement {
  const div = document.createElement("div");

  if (line === "") {
    // Empty line needs height; the lone <br> is treated as 0 chars by the
    // serializer so it never leaks into the markdown.
    div.appendChild(document.createElement("br"));
    return div;
  }

  const heading = /^(#{1,6})(\s+)(.*)$/.exec(line);
  if (heading) {
    div.className = `${HEADING_CLASS[heading[1].length]} text-(--color-foreground-strong)`;
    div.appendChild(marker(heading[1] + heading[2]));
    appendInline(div, heading[3]);
    return div;
  }

  const bullet = /^(\s*)([-*])(\s+)(.*)$/.exec(line);
  if (bullet) {
    // Hanging indent so the marker sits in the gutter and wrapped lines align
    // past it — reads as a real list. The `-`/`*` glyph is shown as a • dot
    // but kept in the text, so serialization stays lossless.
    div.className = "pl-[1.5em] [text-indent:-1.5em]";
    div.appendChild(bulletMarker(bullet[1], bullet[2], bullet[3]));
    appendInline(div, bullet[4]);
    return div;
  }

  const ordered = /^(\s*)(\d+\.)(\s+)(.*)$/.exec(line);
  if (ordered) {
    div.className = "pl-[1.6em] [text-indent:-1.6em]";
    div.appendChild(listMarker(ordered[1] + ordered[2] + ordered[3]));
    appendInline(div, ordered[4]);
    return div;
  }

  appendInline(div, line);
  return div;
}

function marker(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = MARKER_CLASS;
  span.textContent = text;
  return span;
}

// Numbered-list marker (`1.`). Kept legible (not dimmed like inline markers)
// so the number in the gutter reads as a real list marker. Text is preserved
// verbatim, so serialization stays lossless.
function listMarker(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "text-(--color-muted)";
  span.textContent = text;
  return span;
}

// Bullet marker. The literal `-`/`*` glyph is collapsed to zero width and a
// • dot is drawn in its place via ::before — so the user sees a real bullet
// while the marker character stays in the text for lossless serialization.
function bulletMarker(
  lead: string,
  mark: string,
  trail: string,
): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "text-(--color-muted)";
  if (lead) span.appendChild(document.createTextNode(lead));
  const dot = document.createElement("span");
  dot.className = "text-[0px] before:text-[13px] before:content-['•']";
  dot.textContent = mark;
  span.appendChild(dot);
  span.appendChild(document.createTextNode(trail));
  return span;
}

// Mirrors MarkdownText's inline regex, but keeps the delimiters.
const INLINE_RE =
  /(\*\*[^*\n]+?\*\*|`[^`\n]+?`|\*[^*\n\s][^*\n]*?\*|https?:\/\/[^\s<>()]+)/g;

function appendInline(parent: HTMLElement, text: string): void {
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const tok = m[0];
    if (tok.startsWith("**")) {
      parent.appendChild(marker("**"));
      const b = document.createElement("span");
      b.className = "font-semibold text-(--color-foreground-strong)";
      b.textContent = tok.slice(2, -2);
      parent.appendChild(b);
      parent.appendChild(marker("**"));
    } else if (tok.startsWith("`")) {
      parent.appendChild(marker("`"));
      const c = document.createElement("span");
      c.className =
        "rounded-[3px] bg-(--color-panel-soft) px-[3px] font-mono text-(--color-foreground-strong)";
      c.textContent = tok.slice(1, -1);
      parent.appendChild(c);
      parent.appendChild(marker("`"));
    } else if (tok.startsWith("*")) {
      parent.appendChild(marker("*"));
      const i = document.createElement("span");
      i.className = "italic";
      i.textContent = tok.slice(1, -1);
      parent.appendChild(i);
      parent.appendChild(marker("*"));
    } else {
      // bare URL — colour it but leave it as plain editable text
      const a = document.createElement("span");
      a.className = "text-(--color-accent) underline";
      a.textContent = tok;
      parent.appendChild(a);
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) {
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
}

/* ---------------------------------------------------------------------------
 * Serialization: formatted DOM -> markdown string.
 *
 * Handles both our clean structure and the transient messy DOM the browser
 * leaves after a native edit (split divs, stray <br>) — we repaint to clean
 * structure immediately after, so the messy state only ever lasts one event.
 * ------------------------------------------------------------------------- */

function isFillerBr(block: Node): boolean {
  return block.childNodes.length === 1 && block.firstChild?.nodeName === "BR";
}

function blockString(block: Node): string {
  // A <br> that is the block's last child is filler (an empty line, or the
  // bogus trailing <br> browsers leave after a native edit) — it must NOT add
  // a newline. Any other <br> is a real in-line break.
  const trailingBr =
    block.lastChild && block.lastChild.nodeName === "BR" ? block.lastChild : null;
  let s = "";
  const walk = (node: Node) => {
    for (const c of Array.from(node.childNodes)) {
      if (c === trailingBr) continue;
      if (c.nodeType === Node.TEXT_NODE) s += c.nodeValue ?? "";
      else if (c.nodeName === "BR") s += "\n";
      else walk(c);
    }
  };
  walk(block);
  return s;
}

function serialize(root: HTMLElement): string {
  return Array.from(root.childNodes)
    .map((b) =>
      b.nodeType === Node.TEXT_NODE
        ? (b.nodeValue ?? "")
        : b.nodeName === "BR"
          ? ""
          : blockString(b),
    )
    .join("\n");
}

/* ---------------------------------------------------------------------------
 * Caret <-> character offset. The offset is an index into serialize(root).
 * ------------------------------------------------------------------------- */

function lenOf(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.nodeValue ?? "").length;
  if (n.nodeName === "BR") return 1;
  let s = 0;
  for (const c of Array.from(n.childNodes)) s += lenOf(c);
  return s;
}

function blockLength(block: Node): number {
  return isFillerBr(block) ? 0 : lenOf(block);
}

// Caret position as a character offset into serialize(root). Computed by
// cloning everything before the caret and serializing it — so it is, by
// construction, consistent with serialize() regardless of how the browser
// shaped the DOM during the edit.
function currentOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.startContainer, r.startOffset);
  const tmp = document.createElement("div");
  tmp.appendChild(pre.cloneContents());
  return serialize(tmp).length;
}

function setCaret(root: HTMLElement, target: number): void {
  const blocks = Array.from(root.childNodes);
  let remaining = target;
  for (const block of blocks) {
    const len = blockLength(block);
    if (remaining <= len) {
      placeInBlock(block, remaining);
      return;
    }
    remaining -= len + 1; // +1 for the newline that joins blocks
  }
  // Past the end — collapse to the end of the last block.
  const last = blocks[blocks.length - 1];
  if (last) placeInBlock(last, blockLength(last));
}

function placeInBlock(block: Node, off: number): void {
  const range = document.createRange();
  if (block.nodeType === Node.TEXT_NODE) {
    range.setStart(block, Math.min(off, (block.nodeValue ?? "").length));
  } else if (isFillerBr(block) || block.childNodes.length === 0) {
    range.setStart(block, 0);
  } else {
    let remaining = off;
    let placed = false;
    const visit = (n: Node) => {
      if (placed) return;
      if (n.nodeType === Node.TEXT_NODE) {
        const l = (n.nodeValue ?? "").length;
        if (remaining <= l) {
          range.setStart(n, remaining);
          placed = true;
        } else remaining -= l;
        return;
      }
      if (n.nodeName === "BR") {
        if (remaining <= 0) {
          range.setStartBefore(n);
          placed = true;
        } else remaining -= 1;
        return;
      }
      for (const c of Array.from(n.childNodes)) {
        visit(c);
        if (placed) return;
      }
    };
    for (const c of Array.from(block.childNodes)) {
      visit(c);
      if (placed) break;
    }
    if (!placed) {
      range.selectNodeContents(block);
      range.collapse(false);
    }
  }
  range.collapse(true);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}
