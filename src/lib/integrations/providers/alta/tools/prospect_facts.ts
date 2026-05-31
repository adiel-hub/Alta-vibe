/**
 * Surfaces PDL fields that we already store on `ProspectDocument.raw`.
 * Zero external network — just a Mongo round-trip + projection.
 */
import { ObjectId } from "mongodb";
import { prospectsCol } from "@/lib/mongodb";
import type { ProviderRuntimeToolSpec } from "../../types";

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export const ALTA_PROSPECT_FACTS: ProviderRuntimeToolSpec = {
  key: "prospect_facts",
  name: "alta_prospect_facts",
  description:
    "Surface PDL-derived prospect facts that we already store on the Alta prospect record. Exposes account_industry, account_headcount, account_country, caller_work_history, caller_skills_top, caller_education_top as dynamic variables.",
  phase: "pre_call",
  method: "POST",
  path: "alta://prospect_facts",
  category: "Alta",
  execute: async (ctx) => {
    if (!ctx.prospect_id || !ObjectId.isValid(ctx.prospect_id)) return null;
    const prospects = await prospectsCol();
    const doc = await prospects.findOne({ _id: new ObjectId(ctx.prospect_id) });
    if (!doc) return null;
    const raw = (doc.raw ?? {}) as Record<string, unknown>;

    const industry = str(raw.industry);
    const headcount =
      str(raw.job_company_size) ||
      str(raw.job_company_employee_count) ||
      str((raw.job_company as Record<string, unknown> | undefined)?.size);
    const country =
      str(raw.location_country) ||
      str(raw.job_company_location_country) ||
      str((doc.location_name ?? "").split(",").pop()?.trim());

    const experience = arr(raw.experience);
    const workHistorySummary = experience
      .slice(0, 3)
      .map((e) => {
        const ent = e as Record<string, unknown>;
        const title = str(
          (ent.title as Record<string, unknown> | undefined)?.name ?? ent.title,
        );
        const company = str(
          (ent.company as Record<string, unknown> | undefined)?.name ??
            ent.company,
        );
        return [title, company].filter(Boolean).join(" @ ");
      })
      .filter(Boolean)
      .join(" | ");

    const skills = arr(raw.skills).slice(0, 3).map(str).filter(Boolean).join(", ");

    const educationArr = arr(raw.education);
    const education = educationArr
      .slice(0, 1)
      .map((e) => {
        const ent = e as Record<string, unknown>;
        const school = str(
          (ent.school as Record<string, unknown> | undefined)?.name ?? ent.school,
        );
        const degree = str(
          (ent.degrees as unknown[] | undefined)?.[0] ?? ent.degrees,
        );
        return [degree, school].filter(Boolean).join(" — ");
      })
      .join("");

    return {
      account_industry: industry,
      account_headcount: headcount,
      account_country: country,
      caller_work_history: workHistorySummary,
      caller_skills_top: skills,
      caller_education_top: education,
    };
  },
  output_aliases: {
    account_industry: "account_industry",
    account_headcount: "account_headcount",
    account_country: "account_country",
    caller_work_history: "caller_work_history",
    caller_skills_top: "caller_skills_top",
    caller_education_top: "caller_education_top",
  },
  narrative: (ctx, output) => {
    const o = output as Record<string, string> | null;
    if (!o) return null;
    const parts: string[] = [];
    if (o.account_industry || o.account_headcount) {
      const company = ctx.job_company_name || "their company";
      const detail = [o.account_industry, o.account_headcount && `~${o.account_headcount} employees`]
        .filter(Boolean)
        .join(", ");
      parts.push(`${company}${detail ? ` (${detail})` : ""}`);
    }
    if (o.caller_work_history) parts.push(`Background: ${o.caller_work_history}`);
    return parts.length > 0 ? parts.join(". ") : null;
  },
};
