import type { ProviderRuntimeToolSpec } from "../../types";
import { DYNAMICS_RECORD_OBJECT, DYNAMICS_QUERY_SCHEMA } from "../schemas";

/**
 * Dynamics 365 (Dataverse) opportunity tools.
 *
 * Entity set: `opportunities` (EntityType `opportunity`, primary key
 * `opportunityid`). Useful columns: name (topic), estimatedvalue,
 * estimatedclosedate, closeprobability, customerid (account/contact lookup),
 * parentcontactid, parentaccountid. Link the customer with e.g.
 * 'customerid_account@odata.bind': '/accounts(<accountid>)'.
 */
export const DYNAMICS365_OPPORTUNITY_TOOLS: ProviderRuntimeToolSpec[] = [
  {
    key: "create_opportunity",
    name: "dynamics365_create_opportunity",
    description:
      "Create a new Dynamics 365 opportunity (deal). Pass Dataverse column logical " +
      "names (name, estimatedvalue, estimatedclosedate, closeprobability, …) as a flat " +
      "JSON object. Link the customer with 'customerid_account@odata.bind': " +
      "'/accounts(<accountid>)' or 'customerid_contact@odata.bind': '/contacts(<contactid>)'.",
    phase: "in_call",
    method: "POST",
    path: "/api/data/v9.2/opportunities",
    category: "Opportunities",
    body_schema: DYNAMICS_RECORD_OBJECT,
  },
  {
    key: "search_opportunities",
    name: "dynamics365_search_opportunities",
    description:
      "Search Dynamics 365 opportunities with an OData $filter/$select query. Returns " +
      "the matching rows in a `value` array.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/opportunities",
    category: "Opportunities",
    query_schema: DYNAMICS_QUERY_SCHEMA,
  },
  {
    key: "get_opportunity_by_id",
    name: "dynamics365_get_opportunity_by_id",
    description:
      "Fetch a Dynamics 365 opportunity by its opportunityid (GUID). Use $select to " +
      "limit the columns returned.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/opportunities({opportunityId})",
    path_template: true,
    category: "Opportunities",
    query_schema: {
      type: "object",
      properties: {
        opportunityId: {
          type: "string",
          description: "Opportunity GUID (opportunityid), substituted into the URL.",
        },
        $select: {
          type: "string",
          description: "Comma-separated column logical names to return.",
        },
      },
      required: ["opportunityId"],
    },
  },
  {
    key: "update_opportunity",
    name: "dynamics365_update_opportunity",
    description:
      "Update columns on an existing Dynamics 365 opportunity by opportunityid. Only " +
      "pass the columns you want to change.",
    phase: "in_call",
    method: "PATCH",
    path: "/api/data/v9.2/opportunities({opportunityId})",
    path_template: true,
    category: "Opportunities",
    body_schema: {
      type: "object",
      description:
        "Pass `opportunityId` (the GUID to update) plus the column logical names to " +
        "change as sibling keys. `opportunityId` is consumed by the URL and not written.",
      properties: {
        opportunityId: {
          type: "string",
          description: "Opportunity GUID (opportunityid), substituted into the URL.",
        },
      },
      required: ["opportunityId"],
      additionalProperties: true,
    },
  },
];
