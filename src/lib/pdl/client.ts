/**
 * People Data Labs Person Search v5 client. We use it to find dialable
 * prospects: name + role + a real mobile phone number. Authentication is
 * a single `X-Api-Key` header (env: PDL_API_KEY).
 *
 * Docs: https://docs.peopledatalabs.com/docs/quickstart-person-search-api
 *
 * Cost note: PDL bills per matched record returned. We cap `size` at 25
 * by default and surface the per-call total so callers can decide whether
 * to ask for more. The capability tool that wraps this should NOT default
 * to broad queries.
 */
import { createLogger } from "@/lib/logger";

const log = createLogger("pdl");

const PDL_BASE = "https://api.peopledatalabs.com/v5";

/** Normalised prospect shape used everywhere downstream of the PDL client. */
export type PdlProspect = {
  pdl_id: string;
  full_name: string;
  job_title: string | null;
  job_company_name: string | null;
  location_name: string | null;
  mobile_phone: string | null;
  phone_numbers: string[];
  email: string | null;
  linkedin_url: string | null;
  /** Full PDL record retained for persistence; downstream UI ignores. */
  raw: Record<string, unknown>;
  /** User-tagged custom fields from CSV upload (only set by CSV import). */
  custom_fields?: Record<string, string>;
};

/** Raw shape PDL returns; we only project the fields we care about. */
type PdlPersonRecord = {
  id?: string;
  full_name?: string | null;
  job_title?: string | null;
  job_company_name?: string | null;
  location_name?: string | null;
  mobile_phone?: string | null;
  phone_numbers?: string[] | null;
  emails?:
    | Array<{ address?: string | null; type?: string | null }>
    | string[]
    | null;
  linkedin_url?: string | null;
  [key: string]: unknown;
};

type PdlSearchResponse = {
  status: number;
  data?: PdlPersonRecord[];
  total?: number;
  scroll_token?: string | null;
  error?: { type?: string; message?: string };
};

export class PdlError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function getApiKey(): string {
  const key = process.env.PDL_API_KEY;
  if (!key) throw new Error("PDL_API_KEY is not set");
  return key;
}

function pickEmail(emails: PdlPersonRecord["emails"]): string | null {
  if (!emails) return null;
  if (Array.isArray(emails) && emails.length > 0) {
    const first = emails[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "address" in first) {
      const addr = (first as { address?: string | null }).address;
      return typeof addr === "string" ? addr : null;
    }
  }
  return null;
}

function normaliseRecord(r: PdlPersonRecord): PdlProspect | null {
  if (!r.id || !r.full_name) return null;
  return {
    pdl_id: r.id,
    full_name: r.full_name,
    job_title: r.job_title ?? null,
    job_company_name: r.job_company_name ?? null,
    location_name: r.location_name ?? null,
    mobile_phone: r.mobile_phone ?? null,
    phone_numbers: Array.isArray(r.phone_numbers)
      ? r.phone_numbers.filter((s): s is string => typeof s === "string")
      : [],
    email: pickEmail(r.emails),
    linkedin_url: r.linkedin_url ?? null,
    raw: r as Record<string, unknown>,
  };
}

/**
 * Run a PDL person search. Pass either `sql` (string) or `query` (ES
 * object); the API requires exactly one of the two.
 *
 * When `requireMobile` is true (default) we add an exists filter on
 * `mobile_phone` so we don't burn credits on records we can't call.
 */
export async function searchPersons(input: {
  sql?: string;
  query?: Record<string, unknown>;
  size?: number;
  requireMobile?: boolean;
  /** Forwarded to PDL's `dataset` param; default 'all' for the broadest pool. */
  dataset?:
    | "all"
    | "resume"
    | "email"
    | "phone"
    | "mobile_phone"
    | "street_address"
    | "consumer_social"
    | "developer";
}): Promise<{ prospects: PdlProspect[]; total: number }> {
  const size = Math.max(1, Math.min(100, input.size ?? 10));
  const requireMobile = input.requireMobile !== false;
  const dataset = input.dataset ?? (requireMobile ? "mobile_phone" : "all");

  if (!input.sql && !input.query) {
    throw new Error("searchPersons requires either `sql` or `query`");
  }
  if (input.sql && input.query) {
    throw new Error("searchPersons accepts `sql` OR `query`, not both");
  }

  const body: Record<string, unknown> = { size, dataset, titlecase: true };
  if (input.sql) {
    // SQL path — splice in the mobile filter if requested and the caller
    // didn't already include one.
    const base = input.sql.trim().replace(/;$/, "");
    if (requireMobile && !/mobile_phone\s+is\s+not\s+null/i.test(base)) {
      body.sql = /\bwhere\b/i.test(base)
        ? `${base} AND mobile_phone IS NOT NULL`
        : `${base} WHERE mobile_phone IS NOT NULL`;
    } else {
      body.sql = base;
    }
  } else {
    // ES path — wrap in a bool/must so we can OR in the exists filter
    // without flattening the caller's query shape.
    const must: unknown[] = [input.query];
    if (requireMobile) must.push({ exists: { field: "mobile_phone" } });
    body.query = { bool: { must } };
  }

  log.info("search", {
    size,
    dataset,
    mode: input.sql ? "sql" : "es",
    require_mobile: requireMobile,
  });

  const t0 = Date.now();
  // PDL's docs show curl with `-X GET --data-raw`; we use POST since
  // GET with a body isn't well supported in fetch, and PDL accepts both.
  const res = await fetch(`${PDL_BASE}/person/search`, {
    method: "POST",
    headers: {
      "X-Api-Key": getApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: PdlSearchResponse;
  try {
    parsed = JSON.parse(text) as PdlSearchResponse;
  } catch {
    log.error("non-json response", { status: res.status, snippet: text.slice(0, 200) });
    throw new PdlError(res.status, `Non-JSON response from PDL (${res.status})`, text);
  }
  if (!res.ok || parsed.status >= 400) {
    const msg =
      parsed.error?.message ??
      `PDL search failed (${parsed.status || res.status})`;
    log.warn("error", {
      status: parsed.status || res.status,
      type: parsed.error?.type,
      msg,
    });
    throw new PdlError(parsed.status || res.status, msg, parsed);
  }
  const records = Array.isArray(parsed.data) ? parsed.data : [];
  const prospects = records
    .map(normaliseRecord)
    .filter((p): p is PdlProspect => p !== null);
  log.info("ok", {
    ms: Date.now() - t0,
    count: prospects.length,
    total: parsed.total ?? 0,
  });
  return { prospects, total: parsed.total ?? prospects.length };
}
