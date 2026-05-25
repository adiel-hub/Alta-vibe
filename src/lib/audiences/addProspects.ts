/**
 * Add prospects to an audience. Dedupes the `prospects` collection by
 * `pdl_id` and dedupes the audience's `prospect_ids` array as a set. Used
 * by the select_prospects widget resolver and the audiences API.
 *
 * `targetAudience` may identify an existing audience by id, or describe a
 * new audience to create (just a name; description defaults to ""). When
 * `new_name` matches an existing audience by case-insensitive name, we
 * merge into that one instead of erroring on the unique-name index.
 */
import { ObjectId } from "mongodb";
import { audiencesCol, prospectsCol } from "@/lib/mongodb";
import type { PdlProspect } from "@/lib/pdl/client";
import type { AudienceDocument } from "@/types/agent";

export type AudienceTarget = { id: string } | { new_name: string };

export type AddProspectsResult = {
  audience: AudienceDocument;
  added: number;
  skipped: number;
  total_in_audience: number;
};

export async function persistProspects(
  prospects: PdlProspect[],
): Promise<Map<string, ObjectId>> {
  const map = new Map<string, ObjectId>();
  if (prospects.length === 0) return map;
  const col = await prospectsCol();
  const now = new Date();
  // upsert by pdl_id so re-adding the same PDL record from a different
  // search doesn't create a duplicate.
  for (const p of prospects) {
    const setOnInsert: Record<string, unknown> = {
      pdl_id: p.pdl_id,
      full_name: p.full_name,
      job_title: p.job_title,
      job_company_name: p.job_company_name,
      location_name: p.location_name,
      mobile_phone: p.mobile_phone,
      phone_numbers: p.phone_numbers,
      email: p.email,
      linkedin_url: p.linkedin_url,
      raw: p.raw,
      created_at: now,
    };
    if (p.custom_fields && Object.keys(p.custom_fields).length > 0) {
      setOnInsert.custom_fields = p.custom_fields;
    }
    const upsert = await col.findOneAndUpdate(
      { pdl_id: p.pdl_id },
      { $setOnInsert: setOnInsert },
      { upsert: true, returnDocument: "after" },
    );
    if (upsert?._id) map.set(p.pdl_id, upsert._id);
  }
  return map;
}

export async function addProspectsToAudience(input: {
  target: AudienceTarget;
  prospects: PdlProspect[];
}): Promise<AddProspectsResult> {
  const prospectIdsByPdlId = await persistProspects(input.prospects);
  const orderedIds: ObjectId[] = input.prospects
    .map((p) => prospectIdsByPdlId.get(p.pdl_id))
    .filter((x): x is ObjectId => Boolean(x));

  const audiences = await audiencesCol();
  const now = new Date();

  let audience: AudienceDocument | null;
  if ("id" in input.target) {
    if (!ObjectId.isValid(input.target.id)) {
      throw new Error("Invalid audience id");
    }
    audience = await audiences.findOne({ _id: new ObjectId(input.target.id) });
    if (!audience) throw new Error("Audience not found");
  } else {
    const name = input.target.new_name.trim();
    if (!name) throw new Error("Audience name is required");
    audience = await audiences.findOne({ name });
    if (!audience) {
      const insert = await audiences.insertOne({
        name,
        description: "",
        prospect_ids: [],
        created_at: now,
        updated_at: now,
      } as never);
      audience = await audiences.findOne({ _id: insert.insertedId });
      if (!audience) throw new Error("Failed to create audience");
    }
  }

  const existing = new Set(audience.prospect_ids.map((id) => id.toHexString()));
  const additions: ObjectId[] = [];
  for (const id of orderedIds) {
    const hex = id.toHexString();
    if (!existing.has(hex)) {
      existing.add(hex);
      additions.push(id);
    }
  }

  if (additions.length > 0) {
    await audiences.updateOne(
      { _id: audience._id },
      {
        $push: { prospect_ids: { $each: additions } },
        $set: { updated_at: now },
      },
    );
  }

  const fresh = await audiences.findOne({ _id: audience._id });
  if (!fresh) throw new Error("Audience disappeared during update");

  return {
    audience: fresh,
    added: additions.length,
    skipped: orderedIds.length - additions.length,
    total_in_audience: fresh.prospect_ids.length,
  };
}
