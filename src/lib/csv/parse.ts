/**
 * Tiny CSV parser. Handles the common cases: comma-separated, optional
 * double-quoted fields with "" → " escaping, CRLF/LF line breaks, header
 * row, BOM at the start. Not RFC-4180-strict — good enough for an
 * audience CSV the user typed or exported from a spreadsheet.
 *
 * Returns rows as `Record<string, string>` keyed by header name (lowercased,
 * trimmed). Empty lines are skipped.
 */

export type CsvRow = Record<string, string>;

export function parseCsv(input: string): { headers: string[]; rows: CsvRow[] } {
  // Strip UTF-8 BOM.
  const text = input.replace(/^﻿/, "");
  const lines = splitLines(text);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const cells = parseLine(line);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? "").trim();
    }
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Split the source on row boundaries WITHOUT cutting through a quoted
 * field that itself contains a line break.
 */
function splitLines(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // peek for escaped quote
      if (inQuotes && text[i + 1] === '"') {
        buf += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      buf += c;
      continue;
    }
    if (!inQuotes && (c === "\n" || c === "\r")) {
      // Consume CRLF as one terminator.
      if (c === "\r" && text[i + 1] === "\n") i++;
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        buf += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === ",") {
      cells.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  cells.push(buf);
  return cells;
}

/** Normalise a phone-looking string into best-effort E.164. */
export function normalisePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}
