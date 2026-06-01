/**
 * GET /api/agents/[id]/integrations/[provider]/properties?object=contacts
 *
 * Lists a provider object's available properties (name + label + type) so the
 * pre-call field-mapping UI can offer a real, searchable dropdown — including
 * the workspace's custom properties. Generic by route shape; only HubSpot is
 * implemented today (other providers return 400 until they grow a properties
 * concept).
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { getHubspotToken } from "@/lib/integrations/hubspot/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PropertyRow = { name: string; label: string; type: string };

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; provider: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, provider } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const object = new URL(req.url).searchParams.get("object") ?? "contacts";

  if (provider !== "hubspot") {
    return NextResponse.json(
      { error: `Property listing isn't supported for provider "${provider}".` },
      { status: 400 },
    );
  }

  const token = await getHubspotToken(id);
  if (!token) {
    return NextResponse.json(
      { error: "HubSpot is not connected for this workspace." },
      { status: 409 },
    );
  }

  try {
    const res = await fetch(
      `https://api.hubapi.com/crm/v3/properties/${encodeURIComponent(object)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `HubSpot error (${res.status}): ${body.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as {
      results?: Array<{
        name?: string;
        label?: string;
        type?: string;
        hidden?: boolean;
      }>;
    };
    const properties: PropertyRow[] = (data.results ?? [])
      .filter((p) => typeof p.name === "string" && p.hidden !== true)
      .map((p) => ({
        name: p.name as string,
        label: p.label ?? (p.name as string),
        type: p.type ?? "string",
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return NextResponse.json({ properties });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
