/**
 * Unified pre-call context. Every pre-call tool receives one of these and uses
 * its fields to construct an outgoing HTTP request body (via the spec's
 * `build_body` factory). The dispatcher also surfaces these scalars directly
 * as dynamic variables, so prompts can reference `{{full_name}}`,
 * `{{caller_email}}`, etc. without a tool round-trip.
 *
 * Missing values are empty strings — never null. Tools check truthiness in
 * their `build_body` (e.g. skip the email filter group when caller_email is
 * empty); template substitution stays clean (`{{field:full_name}}` → "").
 */
import { ObjectId } from "mongodb";
import { prospectsCol } from "@/lib/mongodb";

export type CallerContext = {
  to_number: string;
  caller_email: string;
  // Prospect-derived (all empty strings when no prospect_id given or no doc found):
  prospect_id: string;
  full_name: string;
  first_name: string;
  last_name: string;
  job_title: string;
  job_company_name: string;
  linkedin_url: string;
  custom_fields: Record<string, string>;
  // Campaign / audience context (empty for ad-hoc calls):
  audience_id: string;
  campaign_id: string;
};

function splitFullName(full: string): { first: string; last: string } {
  const trimmed = full.trim();
  if (!trimmed) return { first: "", last: "" };
  const space = trimmed.indexOf(" ");
  if (space === -1) return { first: trimmed, last: "" };
  return {
    first: trimmed.slice(0, space),
    last: trimmed.slice(space + 1).trim(),
  };
}

export async function buildCallerContext(input: {
  to_number: string;
  caller_email?: string;
  prospect_id?: string;
  audience_id?: string;
  campaign_id?: string;
}): Promise<CallerContext> {
  const base: CallerContext = {
    to_number: input.to_number,
    caller_email: input.caller_email ?? "",
    prospect_id: "",
    full_name: "",
    first_name: "",
    last_name: "",
    job_title: "",
    job_company_name: "",
    linkedin_url: "",
    custom_fields: {},
    audience_id: input.audience_id ?? "",
    campaign_id: input.campaign_id ?? "",
  };

  if (!input.prospect_id || !ObjectId.isValid(input.prospect_id)) return base;

  const prospects = await prospectsCol();
  const p = await prospects.findOne({ _id: new ObjectId(input.prospect_id) });
  if (!p) return base;

  const { first, last } = splitFullName(p.full_name ?? "");
  return {
    ...base,
    caller_email: input.caller_email ?? p.email ?? "",
    prospect_id: input.prospect_id,
    full_name: p.full_name ?? "",
    first_name: first,
    last_name: last,
    job_title: p.job_title ?? "",
    job_company_name: p.job_company_name ?? "",
    linkedin_url: p.linkedin_url ?? "",
    custom_fields: p.custom_fields ?? {},
  };
}
