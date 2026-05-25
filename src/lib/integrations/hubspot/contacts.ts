/**
 * HubSpot CRM contact-list pull for the audience builder. Returns contacts
 * that have at least a `mobilephone` or `phone` populated, normalised into
 * the same `PdlProspect` shape the select_prospects widget already
 * consumes — so the existing prospect-picker UI works unchanged.
 *
 * Synthetic source id: `hubspot:<contact_id>` (keeps the `pdl_id` column
 * unique across CSV / HubSpot / PDL records).
 */
import { getHubspotToken } from "./auth";
import type { PdlProspect } from "@/lib/pdl/client";

const HUBSPOT_API = "https://api.hubapi.com";

type HubspotContactProperties = {
  firstname?: string;
  lastname?: string;
  company?: string;
  jobtitle?: string;
  email?: string;
  phone?: string;
  mobilephone?: string;
  city?: string;
  state?: string;
  country?: string;
  hs_linkedin_url?: string;
};

type HubspotSearchResponse = {
  results?: Array<{
    id: string;
    properties?: HubspotContactProperties;
  }>;
  total?: number;
};

export type HubspotContactsResult = {
  prospects: PdlProspect[];
  total: number;
};

function normaliseE164(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return digits;
  // Best effort: assume US if 10 digits and no country prefix. The user
  // can edit the audience later; better to surface and let them fix than
  // to drop.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export async function listHubspotContactsWithPhone(
  agentMongoId: string,
  opts: { limit?: number } = {},
): Promise<HubspotContactsResult> {
  const token = await getHubspotToken(agentMongoId);
  if (!token) {
    throw new Error(
      "HubSpot is not connected for this agent. Connect HubSpot first.",
    );
  }
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  // HubSpot's search API requires at least one filter; "mobilephone HAS_PROPERTY"
  // surfaces the dialable contacts directly (callers without phones are
  // useless for outbound campaigns).
  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [
            { propertyName: "mobilephone", operator: "HAS_PROPERTY" },
          ],
        },
        // OR group — contacts with `phone` but no `mobilephone` also count.
        {
          filters: [
            { propertyName: "phone", operator: "HAS_PROPERTY" },
          ],
        },
      ],
      properties: [
        "firstname",
        "lastname",
        "company",
        "jobtitle",
        "email",
        "phone",
        "mobilephone",
        "city",
        "state",
        "country",
        "hs_linkedin_url",
      ],
      limit,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HubSpot search failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as HubspotSearchResponse;
  const rows = json.results ?? [];
  const prospects: PdlProspect[] = [];
  for (const r of rows) {
    const p = r.properties ?? {};
    const phone = normaliseE164(p.mobilephone ?? p.phone);
    if (!phone) continue;
    const fullName = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
    const location = [p.city, p.state, p.country].filter(Boolean).join(", ");
    prospects.push({
      pdl_id: `hubspot:${r.id}`,
      full_name: fullName || (p.email ?? "(no name)"),
      job_title: p.jobtitle ?? null,
      job_company_name: p.company ?? null,
      location_name: location || null,
      mobile_phone: phone,
      phone_numbers: [phone],
      email: p.email ?? null,
      linkedin_url: p.hs_linkedin_url ?? null,
      raw: { hubspot_id: r.id, ...p },
    });
  }
  return { prospects, total: json.total ?? prospects.length };
}
