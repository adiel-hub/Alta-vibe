import type { ProviderRuntimeToolSpec } from "../../types";
import { DYNAMICS_RECORD_OBJECT, DYNAMICS_QUERY_SCHEMA } from "../schemas";

/**
 * Dynamics 365 (Dataverse) contact tools.
 *
 * Entity set: `contacts` (EntityType `contact`, primary key `contactid`).
 * Useful logical column names:
 *   firstname, lastname, fullname, emailaddress1, telephone1, mobilephone,
 *   jobtitle, parentcustomerid (account/contact lookup; the related account's
 *   name surfaces as `_parentcustomerid_value@OData.Community.Display.V1.FormattedValue`
 *   when annotations are requested).
 *
 * ── Pre-call lookup ─────────────────────────────────────────────────────────
 * Dataverse reads are GET requests with `$filter`/`$select` on the entity-set
 * URL (no POST/search endpoint like HubSpot). The lookup therefore targets
 * `GET /api/data/v9.2/contacts` with the filter expressed in the path's query
 * string. The caller's email is woven in via a `{{field:caller_email}}`
 * placeholder so the lifecycle dispatcher substitutes the live value before the
 * request leaves the proxy. Results land in the standard `value` array, which
 * we project into the same flat `caller_*` variables HubSpot emits (plus a
 * provider-appropriate `caller_dynamics_contact_id`) so the enrichment system
 * stays uniform across CRMs.
 */
export const DYNAMICS365_CONTACT_TOOLS: ProviderRuntimeToolSpec[] = [
  // ── Contacts ──────────────────────────────────────────────────────────
  {
    key: "lookup_contact",
    name: "dynamics365_lookup_contact",
    description:
      "Look up a Dynamics 365 contact by email; exposes caller_first_name, " +
      "caller_last_name, caller_company, caller_title, caller_email, " +
      "caller_phone, caller_dynamics_contact_id as dynamic variables.",
    phase: "pre_call",
    method: "GET",
    // Dataverse reads are GET-with-OData-query. The caller email must reach the
    // upstream `$filter`, but the shared dispatcher fires a GET with no body and
    // the proxy does NOT interpolate `{{field:}}` into spec.path — so the email
    // is carried via the proxy's `{var}` path-template mechanism instead:
    // `build_body` returns the real email under `caller_email`, the dispatcher
    // POSTs that body to the proxy (the upstream verb stays GET — see fireHttp),
    // and the proxy substitutes `{caller_email}` into the path (URL-encoding it)
    // and strips it from the body before issuing the bodyless GET upstream.
    // We $expand the parent account so its name comes back as a real nested
    // object (value[0].parentcustomerid_account.name) that the dot-path output
    // projector can read. The FormattedValue annotation approach won't work
    // here: (a) the proxy sends no `Prefer: odata.include-annotations` header so
    // the annotation isn't returned, and (b) the annotation's JSON key itself
    // contains dots, which the dot-path projector can't address. $expand avoids
    // both problems. parentcustomerid is polymorphic (account|contact); the
    // typed navigation property `parentcustomerid_account` targets the account.
    path:
      "/api/data/v9.2/contacts" +
      "?$select=firstname,lastname,fullname,emailaddress1,telephone1,mobilephone,jobtitle" +
      "&$expand=parentcustomerid_account($select=name)" +
      "&$filter=emailaddress1 eq '{caller_email}'" +
      "&$top=1",
    path_template: true,
    category: "Contacts",
    // Return the real caller email so the proxy can lift it into `{caller_email}`
    // in the path. Return null to skip the lookup when we have no email to match.
    build_body: (ctx) => (ctx.caller_email ? { caller_email: ctx.caller_email } : null),
    output_aliases: {
      caller_first_name: "value.0.firstname",
      caller_last_name: "value.0.lastname",
      caller_company: "value.0.parentcustomerid_account.name",
      caller_title: "value.0.jobtitle",
      caller_email: "value.0.emailaddress1",
      caller_phone: "value.0.telephone1",
      caller_dynamics_contact_id: "value.0.contactid",
    },
    // Lets users RE-MAP the default-selected columns above onto their own
    // variable names (output projection only). NOTE: unlike HubSpot/Salesforce,
    // enrichment's field-mapping augmentation appends to the BODY key named by
    // request_properties_key, but Dataverse's $select lives in the path here —
    // so extra (custom) columns that aren't already in the path's $select are
    // NOT fetched and won't resolve. Mapping a custom column also requires
    // adding it to the path $select above. Default columns remap correctly.
    field_mapping: {
      object: "contacts",
      request_properties_key: "$select",
      output_path_template: "value.0.{property}",
    },
    narrative: (_ctx, output) => {
      const o = output as
        | { value?: Array<Record<string, unknown> & { parentcustomerid_account?: { name?: unknown } | null }> }
        | null;
      const hit = o?.value?.[0];
      if (!hit) return null;
      const first = typeof hit.firstname === "string" ? hit.firstname : "";
      const company =
        typeof hit.parentcustomerid_account?.name === "string"
          ? hit.parentcustomerid_account.name
          : "";
      const title = typeof hit.jobtitle === "string" ? hit.jobtitle : "";
      const parts: string[] = [];
      if (first && company) parts.push(`${first} from ${company}`);
      else if (first) parts.push(`${first}`);
      else if (company) parts.push(`Contact at ${company}`);
      if (title) parts.push(title);
      return parts.length > 0 ? parts.join(", ") + "." : null;
    },
  },
  {
    key: "create_contact",
    name: "dynamics365_create_contact",
    description:
      "Create a new Dynamics 365 contact. Pass Dataverse column logical names " +
      "(firstname, lastname, emailaddress1, telephone1, mobilephone, jobtitle, …) " +
      "as a flat JSON object. Link an account with " +
      "'parentcustomerid_account@odata.bind': '/accounts(<accountid>)'.",
    phase: "in_call",
    method: "POST",
    path: "/api/data/v9.2/contacts",
    category: "Contacts",
    body_schema: DYNAMICS_RECORD_OBJECT,
  },
  {
    key: "search_contacts",
    name: "dynamics365_search_contacts",
    description:
      "Search Dynamics 365 contacts with an OData $filter/$select query. Use for " +
      "mid-conversation lookups beyond the pre-call enrichment. Returns the matching " +
      "rows in a `value` array.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/contacts",
    category: "Contacts",
    query_schema: DYNAMICS_QUERY_SCHEMA,
  },
  {
    key: "get_contact_by_id",
    name: "dynamics365_get_contact_by_id",
    description:
      "Fetch a Dynamics 365 contact by its contactid (GUID). Use $select to limit " +
      "the columns returned.",
    phase: "in_call",
    method: "GET",
    path: "/api/data/v9.2/contacts({contactId})",
    path_template: true,
    category: "Contacts",
    query_schema: {
      type: "object",
      properties: {
        contactId: {
          type: "string",
          description: "Contact GUID (contactid), substituted into the URL.",
        },
        $select: {
          type: "string",
          description: "Comma-separated column logical names to return.",
        },
      },
      required: ["contactId"],
    },
  },
  {
    key: "update_contact",
    name: "dynamics365_update_contact",
    description:
      "Update columns on an existing Dynamics 365 contact by contactid. Only pass " +
      "columns you want to change (Dataverse fires business logic on every supplied " +
      "column, even unchanged ones).",
    phase: "in_call",
    method: "PATCH",
    path: "/api/data/v9.2/contacts({contactId})",
    path_template: true,
    category: "Contacts",
    // Flat body: `contactId` is lifted into the URL by the proxy and stripped
    // from the forwarded body; every other key is a Dataverse column to update.
    body_schema: {
      type: "object",
      description:
        "Pass `contactId` (the GUID to update) plus the column logical names to " +
        "change as sibling keys, e.g. { contactId: '<guid>', jobtitle: 'VP Sales', " +
        "telephone1: '+1...' }. `contactId` is consumed by the URL and not written.",
      properties: {
        contactId: {
          type: "string",
          description: "Contact GUID (contactid), substituted into the URL.",
        },
      },
      required: ["contactId"],
      additionalProperties: true,
    },
  },
];
