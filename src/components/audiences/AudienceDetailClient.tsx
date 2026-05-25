"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { appFetch } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import type { AudienceDetailProspect } from "@/app/audiences/[id]/page";
import { StartCampaignModal } from "./StartCampaignModal";
import { CampaignProgress } from "./CampaignProgress";

export type AudienceDetailData = {
  id: string;
  name: string;
  description: string;
  prospect_count: number;
  created_at: string;
  updated_at: string;
  prospects: AudienceDetailProspect[];
};

export function AudienceDetailClient({
  initial,
}: {
  initial: AudienceDetailData;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(null);

  const removeProspect = async (prospectId: string, label: string) => {
    if (!confirm(`Remove ${label} from "${data.name}"?`)) return;
    try {
      const res = await appFetch(`/api/audiences/${data.id}/prospects`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prospect_ids: [prospectId] }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Remove failed (${res.status})`);
      }
      setData((d) => ({
        ...d,
        prospects: d.prospects.filter((p) => p.id !== prospectId),
        prospect_count: d.prospect_count - 1,
      }));
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Remove failed");
    }
  };

  const dialable = data.prospects.filter((p) => p.mobile_phone).length;

  return (
    <div className="mt-3">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-(--color-foreground-strong)">
            {data.name}
          </h1>
          <p className="mt-1 text-sm text-(--color-muted)">
            {data.prospect_count} prospect{data.prospect_count === 1 ? "" : "s"}
            {" • "}
            {dialable} dialable
          </p>
        </div>
        <Button
          disabled={dialable === 0}
          onClick={() => setModalOpen(true)}
        >
          Start campaign
        </Button>
      </div>

      {activeCampaignId && (
        <div className="mb-6">
          <CampaignProgress
            audienceId={data.id}
            campaignId={activeCampaignId}
            onDismiss={() => setActiveCampaignId(null)}
          />
        </div>
      )}

      {data.prospects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-(--color-border) bg-(--color-panel-soft) p-10 text-center">
          <p className="text-sm text-(--color-muted)">
            No prospects yet. Ask your agent to run a PDL search and add
            results to this audience.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-(--color-border) bg-white">
          <table className="w-full text-sm">
            <thead className="bg-(--color-panel-soft) text-left text-[11px] uppercase tracking-wide text-(--color-muted)">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Mobile</th>
                <th className="px-4 py-2">Location</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.prospects.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-(--color-border) text-xs hover:bg-(--color-panel-soft)/50"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-(--color-foreground-strong)">
                      {p.full_name}
                    </div>
                    {p.email && (
                      <div className="text-(--color-muted)">{p.email}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-(--color-foreground)">
                    {[p.job_title, p.job_company_name]
                      .filter(Boolean)
                      .join(" @ ") || "—"}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-(--color-foreground)">
                    {p.mobile_phone ?? (
                      <span className="text-(--color-muted)">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-(--color-muted)">
                    {p.location_name ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => void removeProspect(p.id, p.full_name)}
                      className="rounded-md px-2 py-1 text-[11px] text-(--color-muted) hover:bg-(--color-danger)/10 hover:text-(--color-danger)"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <StartCampaignModal
          audienceId={data.id}
          audienceName={data.name}
          dialable={dialable}
          onClose={() => setModalOpen(false)}
          onStarted={(id) => {
            setModalOpen(false);
            setActiveCampaignId(id);
          }}
        />
      )}
    </div>
  );
}
