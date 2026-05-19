import type { ProviderRuntimeToolSpec } from "../../types";

export const HUBSPOT_ASSOCIATION_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Associations ──────────────────────────────────────────────────────
  {
    key: "associate_contact_to_company",
    name: "hubspot_associate_contact_to_company",
    description: "Associate a HubSpot contact with a company using the default association type.",
    phase: "in_call",
    method: "PUT",
    path: "/crm/v4/objects/contacts/{contactId}/associations/default/companies/{companyId}",
    path_template: true,
    category: "Associations",
    query_schema: {
      properties: {
        contactId: { type: "string", description: "HubSpot contact record id." },
        companyId: { type: "string", description: "HubSpot company record id." },
      },
      required: ["contactId", "companyId"],
    },
  },
  {
    key: "associate_deal_to_contact",
    name: "hubspot_associate_deal_to_contact",
    description: "Associate a HubSpot deal with a contact using the default association type.",
    phase: "in_call",
    method: "PUT",
    path: "/crm/v4/objects/deals/{dealId}/associations/default/contacts/{contactId}",
    path_template: true,
    category: "Associations",
    query_schema: {
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id." },
        contactId: { type: "string", description: "HubSpot contact record id." },
      },
      required: ["dealId", "contactId"],
    },
  },
  {
    key: "associate_deal_to_company",
    name: "hubspot_associate_deal_to_company",
    description: "Associate a HubSpot deal with a company using the default association type.",
    phase: "in_call",
    method: "PUT",
    path: "/crm/v4/objects/deals/{dealId}/associations/default/companies/{companyId}",
    path_template: true,
    category: "Associations",
    query_schema: {
      properties: {
        dealId: { type: "string", description: "HubSpot deal record id." },
        companyId: { type: "string", description: "HubSpot company record id." },
      },
      required: ["dealId", "companyId"],
    },
  },
];
