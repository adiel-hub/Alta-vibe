/**
 * CSV column → prospect field mapping. The upload widget asks the user to
 * tag each CSV column with a target field (phone, name, email, …) or
 * "custom" to keep it as a labeled property on the prospect. This module
 * owns:
 *
 *   - the canonical field vocabulary
 *   - the alias table used to auto-detect a starting mapping from headers
 *   - applyMapping(): row → prospect (replaces the old rowToProspect)
 *   - validateMapping(): the rules the UI surfaces (phone required, no
 *     conflicting duplicates)
 *
 * Phone is still required to be dialable for a row to produce a prospect —
 * rows without one are skipped, same as before.
 */
import type { CsvRow } from "./parse";
import { normalisePhone } from "./parse";
import type { PdlProspect } from "@/lib/pdl/client";

export type CanonicalField =
  | "phone"
  | "full_name"
  | "first_name"
  | "last_name"
  | "email"
  | "job_title"
  | "company"
  | "location"
  | "linkedin_url";

export type FieldTarget =
  | { kind: "canonical"; field: CanonicalField }
  | { kind: "custom"; name: string }
  | { kind: "ignore" };

/** Mapping keyed by the lowercased CSV header (matches parseCsv's row keys). */
export type ColumnMapping = Record<string, FieldTarget>;

/**
 * Header aliases — lowercased, alphanumeric/underscore-only. autoDetectMapping
 * normalises a CSV header the same way before comparing, so "Mobile Phone",
 * "mobile_phone", and "mobilephone" all hit the same alias.
 */
const HEADER_ALIASES: Record<CanonicalField, string[]> = {
  phone: ["mobile_phone", "mobilephone", "phone", "mobile", "cell", "cellphone", "cell_phone", "phone_number", "phonenumber"],
  full_name: ["full_name", "fullname", "name", "contact_name", "contactname"],
  first_name: ["first_name", "firstname", "first", "given_name", "givenname"],
  last_name: ["last_name", "lastname", "last", "surname", "family_name", "familyname"],
  email: ["email", "email_address", "emailaddress", "e_mail"],
  job_title: ["job_title", "jobtitle", "title", "role", "position"],
  company: ["company", "job_company_name", "jobcompanyname", "organization", "organisation", "org", "employer"],
  location: ["location", "location_name", "locationname", "city", "address"],
  linkedin_url: ["linkedin", "linkedin_url", "linkedinurl", "linkedin_profile", "linkedinprofile"],
};

function normaliseHeaderKey(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/**
 * Best-guess mapping for a fresh CSV. Returns a mapping keyed by the row
 * header (already lowercased by parseCsv) where each header resolves to a
 * canonical field, or {kind: "ignore"} if nothing matched.
 *
 * If two headers both alias to the same canonical field (e.g. both "phone"
 * and "mobile_phone"), the first one wins and the second falls back to
 * "ignore" — the user can fix it in the mapping UI.
 */
export function autoDetectMapping(headers: string[]): ColumnMapping {
  const result: ColumnMapping = {};
  const taken = new Set<CanonicalField>();

  for (const header of headers) {
    const norm = normaliseHeaderKey(header);
    let matched: CanonicalField | null = null;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [
      CanonicalField,
      string[],
    ][]) {
      if (taken.has(field)) continue;
      if (aliases.includes(norm)) {
        matched = field;
        break;
      }
    }
    if (matched) {
      taken.add(matched);
      result[header] = { kind: "canonical", field: matched };
    } else {
      result[header] = { kind: "ignore" };
    }
  }
  return result;
}

/**
 * Validate a mapping for the UI. Returns a flat list of human-readable
 * errors. `ok` is true when the user could submit.
 */
export function validateMapping(mapping: ColumnMapping): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const canonicalCounts = new Map<CanonicalField, number>();
  const customNameCounts = new Map<string, number>();

  for (const target of Object.values(mapping)) {
    if (target.kind === "canonical") {
      canonicalCounts.set(target.field, (canonicalCounts.get(target.field) ?? 0) + 1);
    } else if (target.kind === "custom") {
      const name = target.name.trim();
      if (!name) {
        errors.push("Custom field is missing a name.");
        continue;
      }
      customNameCounts.set(name, (customNameCounts.get(name) ?? 0) + 1);
    }
  }

  if ((canonicalCounts.get("phone") ?? 0) === 0) {
    errors.push("Map one column to Phone — it's required to dial.");
  }

  // full_name and (first_name + last_name) can both be present; the row
  // applier prefers full_name. Anything else mapped twice is a conflict.
  for (const [field, count] of canonicalCounts) {
    if (count > 1) {
      errors.push(`Two columns are mapped to ${labelFor(field)} — pick one.`);
    }
  }

  for (const [name, count] of customNameCounts) {
    if (count > 1) {
      errors.push(`Two custom fields share the name "${name}" — rename one.`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Apply a mapping to a single parsed CSV row. Returns null when the row has
 * no dialable phone — same skip rule as the prior rowToProspect.
 */
export function applyMapping(
  row: CsvRow,
  mapping: ColumnMapping,
): PdlProspect | null {
  const canonical: Partial<Record<CanonicalField, string>> = {};
  const customFields: Record<string, string> = {};

  for (const [header, target] of Object.entries(mapping)) {
    const value = (row[header] ?? "").trim();
    if (!value) continue;
    if (target.kind === "canonical") {
      // First non-empty wins (mapping enforces uniqueness via validateMapping,
      // but be defensive in case the UI ever calls applyMapping with conflicts).
      if (canonical[target.field] === undefined) canonical[target.field] = value;
    } else if (target.kind === "custom") {
      const name = target.name.trim();
      if (name) customFields[name] = value;
    }
  }

  const phone = normalisePhone(canonical.phone);
  if (!phone) return null;

  const fullName =
    canonical.full_name ??
    [canonical.first_name, canonical.last_name]
      .filter((s): s is string => Boolean(s))
      .join(" ")
      .trim();

  return {
    pdl_id: `csv:${phone}`,
    full_name: fullName || phone,
    job_title: canonical.job_title ?? null,
    job_company_name: canonical.company ?? null,
    location_name: canonical.location ?? null,
    mobile_phone: phone,
    phone_numbers: [phone],
    email: canonical.email ?? null,
    linkedin_url: canonical.linkedin_url ?? null,
    raw: { ...row },
    custom_fields: Object.keys(customFields).length > 0 ? customFields : undefined,
  };
}

/** Human label for a canonical field — used by the UI dropdown and errors. */
export function labelFor(field: CanonicalField): string {
  switch (field) {
    case "phone":
      return "Phone";
    case "full_name":
      return "Full name";
    case "first_name":
      return "First name";
    case "last_name":
      return "Last name";
    case "email":
      return "Email";
    case "job_title":
      return "Job title";
    case "company":
      return "Company";
    case "location":
      return "Location";
    case "linkedin_url":
      return "LinkedIn URL";
  }
}

/** Ordered list for the UI dropdown — Phone first since it's required. */
export const CANONICAL_FIELDS_ORDERED: CanonicalField[] = [
  "phone",
  "full_name",
  "first_name",
  "last_name",
  "email",
  "job_title",
  "company",
  "location",
  "linkedin_url",
];
