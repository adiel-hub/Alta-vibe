import type { ProviderRuntimeToolSpec } from "../../types";

export const HUBSPOT_METADATA_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Owners / metadata ─────────────────────────────────────────────────
  {
    key: "list_owners",
    name: "hubspot_list_owners",
    description: "List HubSpot users (owners) available for assignment. Returns id, email, firstName, lastName for each.",
    phase: "in_call",
    method: "GET",
    path: "/crm/v3/owners",
    category: "Metadata",
    query_schema: {
      properties: {
        email: { type: "string", description: "Filter by exact owner email." },
        limit: { type: "integer", description: "Max records (default 100)." },
      },
    },
  },
];
