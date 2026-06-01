/**
 * Per-tool install/uninstall endpoints for provider catalogs (HubSpot,
 * Slack, etc.). The UI's "Browse integrations" section calls these.
 *
 *   GET  /api/agents/:id/provider-tools         → catalog + installed flags
 *   POST /api/agents/:id/provider-tools         → { provider, tool_key }
 *   DELETE /api/agents/:id/provider-tools?id=…  → uninstall by tool id
 *   DELETE /api/agents/:id/provider-tools?name=…→ uninstall by tool name
 *
 * The chat-driven path (capability `install_provider_tool`) and the UI
 * path both end up in installProviderTool / uninstallProviderTool, so
 * behavior stays in sync.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { listConnectedWorkspaceProviders } from "@/lib/integrations/store";
import { PROVIDERS, scopedToolName } from "@/lib/integrations/providers";
import {
  installProviderTool,
  uninstallProviderTool,
} from "@/lib/integrations/registerProviderTools";
import { setBindingFieldMappings } from "@/lib/tools/bindings";
import { ElevenLabsError, patchAgent } from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InstallBody = z.object({
  provider: z.string().min(1),
  tool_key: z.string().min(1),
});

// PATCH — set per-agent custom field mappings on an installed pre-call tool.
// Variable names must be safe dynamic-variable identifiers.
const ConfigBody = z.object({
  tool_name: z.string().min(1),
  field_mappings: z
    .array(
      z.object({
        property: z.string().min(1),
        variable: z
          .string()
          .min(1)
          .regex(
            /^[a-zA-Z_][a-zA-Z0-9_]*$/,
            "Variable names must start with a letter/underscore and contain only letters, digits, underscores.",
          ),
      }),
    )
    .max(50),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const installedNames = new Set(agent.config_cache.tools.map((t) => t.name));
  // Connected state is workspace-shared now — any agent's connection
  // turns the provider on for every other agent in the workspace.
  const connectedProviders = await listConnectedWorkspaceProviders();

  const catalog = PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    icon: p.icon,
    connected: connectedProviders.has(p.id),
    // Built-in providers (e.g. Alta itself) — the UI uses this to show a
    // "built-in" badge instead of a Connect / connected affordance, since
    // "connecting the platform to itself" makes no sense to the user.
    built_in: p.always_connected === true,
    tools: p.runtime_tools.map((t) => ({
      key: t.key,
      name: scopedToolName(t),
      description: t.description,
      phase: t.phase,
      method: t.method,
      category: t.category ?? "Other",
      installed: installedNames.has(scopedToolName(t)),
      // Which provider object's properties are mappable for this tool (if
      // any) + the built-in property→variable defaults — together they drive
      // the pre-call field-mapping editor (defaults shown locked, customs editable).
      ...(t.field_mapping
        ? {
            mappable_object: t.field_mapping.object,
            default_field_mappings: Object.entries(t.output_aliases ?? {}).map(
              ([variable, path]) => {
                // `mappable` = the path is a real provider property (matches the
                // template prefix, e.g. "results.0.properties."), so the UI can
                // offer a property dropdown. Non-mappable defaults (e.g. the
                // record id at "results.0.id") render read-only.
                const prefix =
                  t.field_mapping!.output_path_template.split("{property}")[0];
                const mappable = path.startsWith(prefix);
                return {
                  variable,
                  property: mappable
                    ? path.slice(prefix.length)
                    : (path.split(".").pop() ?? path),
                  mappable,
                };
              },
            ),
          }
        : {}),
    })),
  }));

  return NextResponse.json({ revision: agent.revision, catalog });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = InstallBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  try {
    const { entry, upstreamPatch } = await installProviderTool(
      id,
      parsed.data.provider,
      parsed.data.tool_key,
    );
    const agents = await agentsCol();
    const agent = await agents.findOne({ _id: new ObjectId(id) });
    if (agent) {
      await patchAgent(agent.elevenlabs_agent_id, upstreamPatch);
    }
    return NextResponse.json({
      revision: agent?.revision ?? 0,
      tool: entry,
    });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const url = new URL(req.url);
  const tool_id = url.searchParams.get("id");
  const tool_name = url.searchParams.get("name");
  if (!tool_id && !tool_name) {
    return NextResponse.json(
      { error: "Pass ?id=… or ?name=… to identify the tool to uninstall." },
      { status: 400 },
    );
  }

  try {
    const { removed_id, remaining, upstreamPatch } = await uninstallProviderTool(
      id,
      { id: tool_id ?? undefined, name: tool_name ?? undefined },
    );
    const agents = await agentsCol();
    const agent = await agents.findOne({ _id: new ObjectId(id) });
    // upstreamPatch is undefined for local-only lifecycle tools — nothing to send.
    if (agent && upstreamPatch) {
      await patchAgent(agent.elevenlabs_agent_id, upstreamPatch);
    }
    return NextResponse.json({
      revision: agent?.revision ?? 0,
      removed_id,
      tools: remaining,
    });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = ConfigBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  try {
    const { tools, revision, workflow } = await setBindingFieldMappings(
      id,
      parsed.data.tool_name,
      parsed.data.field_mappings,
    );
    // Field mappings are local-only (no ElevenLabs tool change), so we just
    // hand the client the new derived tools + workflow to apply.
    return NextResponse.json({
      revision,
      patch: { tools, workflow },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
