"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import { sendMessage } from "@/store/sseClient";
import { Button } from "@/components/ui/Button";
import type { PhoneNumber } from "@/types/agent";

// E.164 country code → ISO-3166-1 alpha-2 mapping. Covers the calling
// codes most likely to show up in our user base. Falls back to no flag /
// no national reformat when unknown — we don't ship libphonenumber-js
// because it would be overkill for the few formatting hints the card
// needs to render.
const COUNTRY_CODES: Array<{ dial: string; iso: string }> = [
  { dial: "972", iso: "IL" },
  { dial: "1", iso: "US" },
  { dial: "44", iso: "GB" },
  { dial: "33", iso: "FR" },
  { dial: "49", iso: "DE" },
  { dial: "34", iso: "ES" },
  { dial: "39", iso: "IT" },
  { dial: "31", iso: "NL" },
  { dial: "351", iso: "PT" },
  { dial: "353", iso: "IE" },
  { dial: "41", iso: "CH" },
  { dial: "43", iso: "AT" },
  { dial: "32", iso: "BE" },
  { dial: "45", iso: "DK" },
  { dial: "46", iso: "SE" },
  { dial: "47", iso: "NO" },
  { dial: "48", iso: "PL" },
  { dial: "61", iso: "AU" },
  { dial: "64", iso: "NZ" },
  { dial: "55", iso: "BR" },
  { dial: "52", iso: "MX" },
  { dial: "91", iso: "IN" },
  { dial: "86", iso: "CN" },
  { dial: "81", iso: "JP" },
  { dial: "82", iso: "KR" },
  { dial: "65", iso: "SG" },
  { dial: "971", iso: "AE" },
];

function isoFromE164(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  for (const { dial, iso } of COUNTRY_CODES) {
    if (digits.startsWith(dial)) return iso;
  }
  return null;
}

function flagFor(iso: string): string {
  // ISO alpha-2 → regional indicator emoji
  return iso
    .toUpperCase()
    .split("")
    .map((c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
    .join("");
}

/**
 * Render an E.164 number in its "natural" national form. For Israeli
 * numbers (+972) that means stripping the country code and prepending a
 * leading 0 (NDC). For US/CA we group as (NNN) NNN-NNNN. For everything
 * else we fall back to a spaced country-code-prefixed form so it stays
 * readable without us shipping a full numbering plan database.
 */
function formatNational(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  const match = COUNTRY_CODES.find((c) => digits.startsWith(c.dial));
  if (!match) return raw;
  const subscriber = digits.slice(match.dial.length);
  if (match.iso === "IL") return `0${subscriber}`;
  if (match.iso === "US" && subscriber.length === 10) {
    return `(${subscriber.slice(0, 3)}) ${subscriber.slice(3, 6)}-${subscriber.slice(6)}`;
  }
  return `+${match.dial} ${subscriber}`;
}

function ProviderMark({ provider }: { provider: string }) {
  const slug = provider.toLowerCase();
  if (slug === "twilio") {
    return (
      <Image
        src="/integrations/twilio.png"
        alt="Twilio"
        width={20}
        height={20}
        className="h-5 w-5"
      />
    );
  }
  return (
    <span className="text-xs uppercase tracking-wider text-(--color-muted)">
      {provider}
    </span>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function PhoneCard({
  agentId,
  number,
  onDetached,
}: {
  agentId: string;
  number: PhoneNumber;
  onDetached: (phoneNumberId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detach = async () => {
    if (busy) return;
    if (
      !confirm(
        `Detach ${number.number} from this agent? The number stays in your workspace and can be re-attached later.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/phone-numbers/${number.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Detach failed (${res.status})`);
      }
      onDetached(number.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Detach failed");
      setBusy(false);
    }
  };

  return (
    <div className="group relative flex aspect-[3/4] w-[180px] flex-col items-center justify-between rounded-xl border border-(--color-border) bg-white px-4 py-5 text-center shadow-sm">
      <button
        type="button"
        onClick={detach}
        disabled={busy}
        title="Detach from agent"
        aria-label="Detach from agent"
        className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-white text-(--color-muted) opacity-0 shadow-sm ring-1 ring-(--color-border) transition hover:bg-(--color-danger) hover:text-white hover:ring-(--color-danger) group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <TrashIcon />
      </button>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-(--color-panel-soft)">
        <ProviderMark provider={number.provider} />
      </div>
      <div className="flex min-h-0 flex-col items-center gap-1">
        <p
          dir="ltr"
          className="font-mono text-sm text-(--color-foreground-strong)"
        >
          {formatNational(number.number)}
        </p>
        {number.label && (
          <p className="line-clamp-2 text-xs text-(--color-muted)">
            {number.label}
          </p>
        )}
      </div>
      {(() => {
        const iso = isoFromE164(number.number);
        if (!iso) return null;
        return (
          <span
            title={iso}
            className="text-xl leading-none"
            aria-label={`Country: ${iso}`}
          >
            {flagFor(iso)}
          </span>
        );
      })()}
      <span className="text-[10px] font-semibold uppercase tracking-wider text-(--color-muted)">
        {number.provider}
      </span>
      {error && (
        <p className="absolute -bottom-5 left-0 right-0 text-[10px] text-(--color-danger)">
          {error}
        </p>
      )}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function PhoneTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const revision = useAgentStore((s) => s.revision);
  const [importing, setImporting] = useState(false);

  // Reconcile the panel against ElevenLabs on mount. We can't trust the
  // cached `config.phone_numbers` — the agent GET response doesn't reliably
  // echo `phone_numbers`, and older assign_phone_number_to_agent calls left
  // placeholder rows. The /phone-numbers endpoint queries the workspace
  // and filters by assigned_agent.agent_id, so it's the source of truth.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch(`/api/agents/${agentId}/phone-numbers`);
        if (!res.ok) return;
        const real = (await res.json()) as PhoneNumber[];
        if (cancelled) return;
        applyConfigDirect({ phone_numbers: real }, revision);
      } catch {
        // best-effort; cached rows remain
      }
    })();
    return () => {
      cancelled = true;
    };
    // Reconcile on agent switch, not on every revision bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  if (!config) return null;

  const importNumber = async () => {
    if (importing) return;
    setImporting(true);
    try {
      await sendMessage(
        agentId,
        "Please open the phone number import widget so I can attach a number to this agent.",
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Attached phone numbers
          </h3>
          <div className="flex items-center gap-3">
            {inFlight.has("phone") && (
              <span className="text-xs text-(--color-accent)">syncing…</span>
            )}
            <Button
              size="sm"
              onClick={importNumber}
              disabled={importing}
              iconLeft={<PlusIcon />}
            >
              {importing ? "Opening…" : "Import"}
            </Button>
          </div>
        </div>
        {config.phone_numbers.length === 0 ? (
          <p className="text-sm text-(--color-muted)">
            No phone numbers yet. Click <span className="font-medium">Import</span> to
            attach one.
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {config.phone_numbers.map((p) => (
              <PhoneCard
                key={p.id}
                agentId={agentId}
                number={p}
                onDetached={(detachedId) =>
                  applyConfigDirect(
                    {
                      phone_numbers: config.phone_numbers.filter(
                        (n) => n.id !== detachedId,
                      ),
                    },
                    revision,
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
