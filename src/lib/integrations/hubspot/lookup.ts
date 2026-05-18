/**
 * Pre-call HubSpot contact lookup. Searches the client's HubSpot CRM by
 * email or phone, returns a flat string-map suitable for ElevenLabs'
 * `dynamic_variables`. Any failure (no contact, network, 401) collapses
 * to `{}` — pre-call enrichment must never block a call.
 */
import { getHubspotToken } from "./auth";

const HUBSPOT_API = "https://api.hubapi.com";

type HubspotContactProperties = {
  firstname?: string;
  lastname?: string;
  company?: string;
  lifecyclestage?: string;
  email?: string;
  phone?: string;
  notes_last_contacted?: string;
  num_associated_deals?: string;
};

type HubspotSearchResponse = {
  results?: Array<{
    id: string;
    properties?: HubspotContactProperties;
  }>;
};

export async function lookupContactByEmailOrPhone(
  agentMongoId: string,
  ident: { email?: string; phone?: string },
): Promise<Record<string, string>> {
  const token = await getHubspotToken(agentMongoId);
  if (!token) return {};

  const filters: Array<{ propertyName: string; operator: string; value: string }> = [];
  if (ident.email) {
    filters.push({ propertyName: "email", operator: "EQ", value: ident.email });
  } else if (ident.phone) {
    filters.push({ propertyName: "phone", operator: "EQ", value: ident.phone });
  } else {
    return {};
  }

  try {
    const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        filterGroups: [{ filters }],
        properties: [
          "firstname",
          "lastname",
          "company",
          "lifecyclestage",
          "email",
          "phone",
          "notes_last_contacted",
          "num_associated_deals",
        ],
        limit: 1,
      }),
    });
    if (!res.ok) return {};
    const json = (await res.json()) as HubspotSearchResponse;
    const hit = json.results?.[0];
    if (!hit) return {};
    const p = hit.properties ?? {};
    const firstName = p.firstname ?? "";
    const lastName = p.lastname ?? "";
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    return {
      caller_name: fullName,
      caller_first_name: firstName,
      caller_last_name: lastName,
      caller_company: p.company ?? "",
      caller_lifecycle_stage: p.lifecyclestage ?? "",
      caller_last_contacted: p.notes_last_contacted ?? "",
      caller_open_deal_count: p.num_associated_deals ?? "",
      caller_hubspot_contact_id: hit.id,
      caller_email: p.email ?? "",
      caller_phone: p.phone ?? "",
    };
  } catch {
    return {};
  }
}
