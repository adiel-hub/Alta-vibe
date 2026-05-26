/**
 * PDL prospect-search capability. Lets the builder agent search People Data
 * Labs for callable prospects (filtered to mobile_phone present), then
 * presents the results to the user as a `select_prospects` widget. When the
 * user picks who to keep, the resolve route persists them and adds them to a
 * workspace-global Audience that the user manages under /audiences.
 *
 * No per-agent config_cache state — audiences are workspace-global, so this
 * capability's `defaultSlice` is empty.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { audiencesCol } from "@/lib/mongodb";
import { searchPersons, PdlError } from "@/lib/pdl/client";
import { listHubspotContactsWithPhone } from "@/lib/integrations/hubspot/contacts";
import { createWidgetAction } from "../experience/widgets";
import type { Capability } from "../types";

export const pdlCapability: Capability = {
  id: "pdl",
  label: "Prospect search (PDL)",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "present_audience_source_picker",
      [
        "Show the user a 3-square picker for how to BUILD an audience: People Data Labs search, sync from HubSpot CRM, or upload a CSV. Use this WHEN the user says they want to create/build an audience or a calling list and HAS NOT already told you the source. After this widget resolves the platform automatically opens the next step (PDL prompt, HubSpot connect-or-fetch, or CSV upload) — your turn ENDS after calling this tool.",
        "Do NOT call this if the user has already named the source (e.g. 'find CTOs on PDL' → call pdl_search_and_present_prospects directly; 'pull my HubSpot contacts' → server will sync them; 'import this CSV' → wait for them to share it).",
        "`title` is a short label shown in the widget header (e.g. 'How do you want to build the list?').",
      ].join("\n"),
      {
        title: z.string().min(2).max(120).optional(),
      },
      async ({ title }) => {
        try {
          const action_id = await createWidgetAction(
            ctx,
            "audience_source_picker",
            { title: title ?? "How do you want to build the audience?" },
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Audience source picker presented (action_id=${action_id}). End your turn; the platform will resume you once the user picks PDL, HubSpot, or CSV.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `present_audience_source_picker failed: ${message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "pdl_search_and_present_prospects",
      [
        "Search People Data Labs for callable prospects (filtered to those with a mobile phone), then immediately show the results to the user as a checklist widget so they can pick who to add to an audience. The user's selection is wired into the workspace audiences system the agent can later run outbound campaigns against.",
        "",
        "Pass EITHER `sql` (preferred — easier for natural-language intent) OR `query` (Elasticsearch v7.7 shape), not both. Examples:",
        "  - sql: \"SELECT * FROM person WHERE job_title='cto' AND location_country='united states'\"",
        "  - sql: \"SELECT * FROM person WHERE job_title_role='engineering' AND job_company_industry='financial services'\"",
        "  - query: { bool: { must: [ { term: { job_title_role: 'sales' } }, { term: { location_region: 'california' } } ] } }",
        "",
        "Available person fields include: full_name, job_title, job_title_role, job_company_name, job_company_industry, job_company_size, location_country, location_region, location_locality, skills, education.school.name. The tool automatically adds a `mobile_phone IS NOT NULL` filter so you don't need to.",
        "",
        "HARD CAP: this tool always returns at most 10 prospects (preview only) — you cannot request more. The widget shows the PDL total next to the preview ('Previewing 10 of N matches') so the user can see how many more matches exist in PDL. If the user asks for more than 10, tell them this is a preview cap; they can save the current 10 to an audience and refine the query to get different prospects. Set `title` to something the user will recognise in their chat ('Monday.com employees', 'CTOs at fintech startups').",
      ].join("\n"),
      {
        sql: z.string().min(10).max(2000).optional(),
        query: z.record(z.string(), z.unknown()).optional(),
        title: z.string().min(2).max(120),
      },
      async ({ sql, query, title }) => {
        // Preview cap is locked to 10 platform-side — the agent has no
        // `size` knob to bump it from chat.
        const size = 10;
        try {
          if (!sql && !query) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "pdl_search_and_present_prospects requires `sql` or `query`.",
                },
              ],
              isError: true,
            };
          }
          const { prospects, total } = await searchPersons({
            sql,
            query,
            size,
            requireMobile: true,
          });
          if (prospects.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `PDL returned 0 callable prospects for that query (total matches in dataset: ${total}). Tell the user the filter was too narrow or returned no records with a mobile phone, and ask if they want to broaden criteria.`,
                },
              ],
            };
          }

          const action_id = await createWidgetAction(ctx, "select_prospects", {
            title,
            total,
            prospects: prospects.map((p) => ({
              pdl_id: p.pdl_id,
              full_name: p.full_name,
              job_title: p.job_title,
              job_company_name: p.job_company_name,
              location_name: p.location_name,
              mobile_phone: p.mobile_phone,
              email: p.email,
              linkedin_url: p.linkedin_url,
              phone_numbers: p.phone_numbers,
              raw: p.raw,
            })),
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `Presented ${prospects.length} prospect${
                  prospects.length === 1 ? "" : "s"
                } to the user (PDL total: ${total}; action_id=${action_id}). End your turn now — you will be resumed once the user picks who to add and to which audience.`,
              },
            ],
          };
        } catch (err) {
          const message =
            err instanceof PdlError
              ? `PDL error ${err.status}: ${err.message}`
              : err instanceof Error
                ? err.message
                : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `pdl_search_and_present_prospects failed: ${message}. Common fixes: (a) for SQL, wrap string literals in single quotes; (b) use job_title_role for broader matches; (c) check field names against PDL docs.`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "present_hubspot_contacts_picker",
      [
        "Pull the workspace's HubSpot contacts that have a phone number and show them to the user as a select_prospects widget so they can pick who to add to an audience. Use this AFTER the user picked 'HubSpot' from the audience source picker, OR when the user says 'pull my HubSpot contacts'.",
        "If HubSpot isn't connected for this agent the tool returns an error — handle it by calling request_user_action(kind='connect_integration', { provider: 'hubspot', reason: '...' }) so the user can paste their token, then retry this tool.",
        "`limit` defaults to 50, max 100. Keep it modest — large pulls are slow and the user can always run the tool again.",
      ].join("\n"),
      {
        limit: z.number().int().min(1).max(100).default(50),
        title: z.string().min(2).max(120).optional(),
      },
      async ({ limit, title }) => {
        try {
          const { prospects, total } = await listHubspotContactsWithPhone(
            ctx.agentMongoId,
            { limit },
          );
          if (prospects.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `HubSpot returned 0 contacts with a phone number (total contacts queried: ${total}). Tell the user their HubSpot contacts don't have phone numbers populated — they'll need to add phones in HubSpot or use a different source.`,
                },
              ],
            };
          }
          const action_id = await createWidgetAction(
            ctx,
            "select_prospects",
            {
              title: title ?? `${prospects.length} HubSpot contact${prospects.length === 1 ? "" : "s"} with phone`,
              total,
              prospects,
            },
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Presented ${prospects.length} HubSpot contact${
                  prospects.length === 1 ? "" : "s"
                } to the user (action_id=${action_id}). End your turn — you'll resume once they pick who to add and to which audience.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `present_hubspot_contacts_picker failed: ${message}. If the error says HubSpot is not connected, use request_user_action(kind='connect_integration', { provider: 'hubspot', reason: 'so we can sync contacts into your audience' }).`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "present_csv_upload_widget",
      "Open the CSV upload widget so the user can paste or drop a CSV file of prospects, then save them to an audience. Use this AFTER the user picked 'CSV' from the audience source picker, OR when the user says they want to import a CSV. The widget parses CSV client-side; you don't need to ask for column names. Your turn ENDS after calling this tool.",
      {
        title: z.string().min(2).max(120).optional(),
      },
      async ({ title }) => {
        try {
          const action_id = await createWidgetAction(ctx, "csv_upload", {
            title: title ?? "Upload prospects CSV",
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `CSV upload widget presented (action_id=${action_id}). End your turn; you will resume once the user submits the CSV.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `present_csv_upload_widget failed: ${message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "present_launch_campaign_widget",
      "Open the launch-campaign widget so the user can pick one of their existing audiences (calling lists) and click Launch to start dialing. Use this when the user says they want to start calling / launch a campaign / run their list. Requires at least one phone number attached to this agent — if `ctx.config.phone_numbers` is empty, do NOT call this tool: tell the user they need to set up a phone number first (use setup_phone_number). Your turn ENDS after calling this tool; you will be resumed once the user launches or cancels.",
      {
        title: z.string().min(2).max(120).optional(),
        /** Optional: preselect an audience id (e.g. one you just listed). */
        audience_id: z.string().optional(),
      },
      async ({ title, audience_id }) => {
        try {
          if (!ctx.config.phone_numbers || ctx.config.phone_numbers.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "Cannot present launch widget: no phone number is attached to this agent. Ask the user to attach a phone number first (call setup_phone_number).",
                },
              ],
              isError: true,
            };
          }
          const action_id = await createWidgetAction(ctx, "launch_campaign", {
            title: title ?? "Pick a list to start calling",
            agent_id: ctx.agentMongoId,
            agent_phone_numbers: ctx.config.phone_numbers,
            preselected_audience_id: audience_id ?? null,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Launch campaign widget presented (action_id=${action_id}). End your turn now; you will be resumed once the user launches or cancels.`,
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `present_launch_campaign_widget failed: ${message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "list_audiences",
      "List the workspace's outbound-calling audiences (name, description, prospect count). Call this BEFORE running pdl_search_and_present_prospects if the user mentions adding to an existing list — so you can pass the audience name through to the widget and the user doesn't have to type it.",
      {},
      async () => {
        try {
          const audiences = await audiencesCol();
          const rows = await audiences
            .find({}, { projection: { name: 1, description: 1, prospect_ids: 1, updated_at: 1 } })
            .sort({ updated_at: -1 })
            .limit(50)
            .toArray();
          const data = rows.map((r) => ({
            id: r._id.toHexString(),
            name: r.name,
            description: r.description,
            prospect_count: Array.isArray(r.prospect_ids)
              ? r.prospect_ids.length
              : 0,
          }));
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(data) },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              { type: "text" as const, text: `list_audiences failed: ${message}` },
            ],
            isError: true,
          };
        }
      },
    ),
  ],
};
