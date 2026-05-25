import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { audiencesCol, prospectsCol } from "@/lib/mongodb";
import { AudienceDetailClient } from "@/components/audiences/AudienceDetailClient";

export const dynamic = "force-dynamic";

export type AudienceDetailProspect = {
  id: string;
  pdl_id: string;
  full_name: string;
  job_title: string | null;
  job_company_name: string | null;
  location_name: string | null;
  mobile_phone: string | null;
  email: string | null;
  linkedin_url: string | null;
};

export default async function AudienceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();
  const data = await loadAudience(id);
  if (!data) notFound();

  return (
    <div className="h-full overflow-y-auto">
      <section className="mx-auto w-full max-w-5xl px-6 pt-6 pb-20">
        <AudienceDetailClient initial={data} />
      </section>
    </div>
  );
}

async function loadAudience(id: string): Promise<
  | {
      id: string;
      name: string;
      description: string;
      prospect_count: number;
      created_at: string;
      updated_at: string;
      prospects: AudienceDetailProspect[];
    }
  | null
> {
  try {
    const audiences = await audiencesCol();
    const audience = await audiences.findOne({ _id: new ObjectId(id) });
    if (!audience) return null;
    const prospects = await prospectsCol();
    const docs =
      audience.prospect_ids.length > 0
        ? await prospects
            .find({ _id: { $in: audience.prospect_ids } })
            .toArray()
        : [];
    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    const ordered: AudienceDetailProspect[] = audience.prospect_ids
      .map((pid) => byId.get(pid.toHexString()))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((p) => ({
        id: p._id.toHexString(),
        pdl_id: p.pdl_id,
        full_name: p.full_name,
        job_title: p.job_title,
        job_company_name: p.job_company_name,
        location_name: p.location_name,
        mobile_phone: p.mobile_phone,
        email: p.email,
        linkedin_url: p.linkedin_url,
      }));
    return {
      id: audience._id.toHexString(),
      name: audience.name,
      description: audience.description,
      prospect_count: audience.prospect_ids.length,
      created_at: audience.created_at.toISOString(),
      updated_at: audience.updated_at.toISOString(),
      prospects: ordered,
    };
  } catch {
    return null;
  }
}
