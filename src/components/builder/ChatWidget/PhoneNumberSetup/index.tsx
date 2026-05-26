"use client";

import { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/Button";
import type { WidgetEntry } from "@/store/agentStore";
import { ResolvedPill } from "../_shared/WidgetFrame";
import { resolveWidget } from "../_shared/resolveWidget";
import { TabButton, Field, SelectField, SecretField } from "./fields";
import {
  EMPTY_TWILIO,
  EMPTY_SIP,
  type TwilioFormState,
  type SipFormState,
} from "./state";

export function PhoneNumberSetupWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as {
    reason: string;
    default_provider?: "twilio" | "sip_trunk";
    attach_after_import?: boolean;
  };
  const [tab, setTab] = useState<"twilio" | "sip_trunk">(
    payload.default_provider ?? "twilio",
  );
  const [twilio, setTwilio] = useState<TwilioFormState>(EMPTY_TWILIO);
  const [sip, setSip] = useState<SipFormState>(EMPTY_SIP);
  const [revealAuth, setRevealAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPending = widget.status === "pending";

  const validate = (): string | null => {
    if (tab === "twilio") {
      if (!twilio.phone_number.trim()) return "Phone number is required.";
      if (!twilio.label.trim()) return "Label is required.";
      if (!twilio.sid.trim()) return "Twilio Account SID is required.";
      if (!twilio.token.trim()) return "Twilio Auth Token is required.";
      return null;
    }
    if (!sip.phone_number.trim()) return "Phone number is required.";
    if (!sip.label.trim()) return "Label is required.";
    if (!sip.outbound_address.trim())
      return "Outbound SIP address is required.";
    return null;
  };

  const submit = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (tab === "twilio") {
        await resolveWidget(agentId, widget, "done", {
          provider: "twilio",
          phone_number: twilio.phone_number.trim(),
          label: twilio.label.trim(),
          sid: twilio.sid.trim(),
          token: twilio.token.trim(),
        });
      } else {
        const creds =
          sip.username.trim().length > 0
            ? {
                username: sip.username.trim(),
                password: sip.password.length > 0 ? sip.password : undefined,
              }
            : null;
        await resolveWidget(agentId, widget, "done", {
          provider: "sip_trunk",
          phone_number: sip.phone_number.trim(),
          label: sip.label.trim(),
          outbound_trunk_config: {
            address: sip.outbound_address.trim(),
            transport: sip.outbound_transport,
            media_encryption: sip.outbound_media_encryption,
            ...(creds ? { credentials: creds } : {}),
          },
        });
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await resolveWidget(agentId, widget, "cancelled");
    } finally {
      setBusy(false);
    }
  };

  if (!isPending) {
    return (
      <div className="animate-scale-in flex items-center justify-between gap-3 p-1">
        <span className="truncate text-sm font-medium text-(--color-foreground-strong)">
          Import a phone number
        </span>
        {widget.status === "done" && <ResolvedPill>Imported</ResolvedPill>}
        {widget.status === "cancelled" && (
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-(--color-muted)">
            Cancelled
          </span>
        )}
        {widget.status === "failed" && (
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-(--color-danger)">
            Failed
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="animate-scale-in overflow-hidden rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) shadow-md">
      <div className="flex items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
        <span className="truncate text-sm font-semibold text-(--color-foreground-strong)">
          Import a phone number
        </span>
      </div>

      {isPending && (
        <>
          <div className="flex border-b border-(--color-border) bg-(--color-panel)">
            <TabButton
              active={tab === "twilio"}
              onClick={() => setTab("twilio")}
            >
              <span className="inline-flex items-center gap-1.5">
                <Image
                  src="/integrations/twilio.png"
                  alt=""
                  width={14}
                  height={14}
                  className="h-3.5 w-3.5"
                />
                Twilio
              </span>
            </TabButton>
            <TabButton
              active={tab === "sip_trunk"}
              onClick={() => setTab("sip_trunk")}
            >
              SIP trunk
            </TabButton>
          </div>

          <div className="space-y-3 bg-(--color-panel) p-4">
            {tab === "twilio" ? (
              <>
                <Field
                  label="Phone number"
                  placeholder="+15551234567"
                  value={twilio.phone_number}
                  onChange={(v) =>
                    setTwilio((s) => ({ ...s, phone_number: v }))
                  }
                  disabled={busy}
                />
                <Field
                  label="Label"
                  placeholder="Sales line"
                  value={twilio.label}
                  onChange={(v) => setTwilio((s) => ({ ...s, label: v }))}
                  disabled={busy}
                />
                <Field
                  label="Twilio Account SID"
                  placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={twilio.sid}
                  mono
                  onChange={(v) => setTwilio((s) => ({ ...s, sid: v }))}
                  disabled={busy}
                />
                <SecretField
                  label="Twilio Auth Token"
                  placeholder="paste token"
                  value={twilio.token}
                  revealed={revealAuth}
                  onToggleReveal={() => setRevealAuth((v) => !v)}
                  onChange={(v) => setTwilio((s) => ({ ...s, token: v }))}
                  disabled={busy}
                />
                <a
                  href="https://www.twilio.com/console"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-[11px] text-(--color-accent) hover:underline"
                >
                  Find SID + Auth Token in Twilio Console →
                </a>
              </>
            ) : (
              <>
                <Field
                  label="Phone number"
                  placeholder="+15551234567"
                  value={sip.phone_number}
                  onChange={(v) => setSip((s) => ({ ...s, phone_number: v }))}
                  disabled={busy}
                />
                <Field
                  label="Label"
                  placeholder="Production trunk"
                  value={sip.label}
                  onChange={(v) => setSip((s) => ({ ...s, label: v }))}
                  disabled={busy}
                />
                <Field
                  label="Outbound SIP address"
                  placeholder="sip.example.com"
                  value={sip.outbound_address}
                  mono
                  onChange={(v) =>
                    setSip((s) => ({ ...s, outbound_address: v }))
                  }
                  disabled={busy}
                />
                <div className="grid grid-cols-2 gap-2">
                  <SelectField
                    label="Transport"
                    value={sip.outbound_transport}
                    onChange={(v) =>
                      setSip((s) => ({
                        ...s,
                        outbound_transport: v as SipFormState["outbound_transport"],
                      }))
                    }
                    disabled={busy}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "udp", label: "UDP" },
                      { value: "tcp", label: "TCP" },
                      { value: "tls", label: "TLS" },
                    ]}
                  />
                  <SelectField
                    label="Media encryption"
                    value={sip.outbound_media_encryption}
                    onChange={(v) =>
                      setSip((s) => ({
                        ...s,
                        outbound_media_encryption:
                          v as SipFormState["outbound_media_encryption"],
                      }))
                    }
                    disabled={busy}
                    options={[
                      { value: "disabled", label: "Disabled" },
                      { value: "allowed", label: "Allowed" },
                      { value: "required", label: "Required" },
                    ]}
                  />
                </div>
                <Field
                  label="SIP username (optional)"
                  placeholder="leave blank for ACL auth"
                  value={sip.username}
                  onChange={(v) => setSip((s) => ({ ...s, username: v }))}
                  disabled={busy}
                />
                <SecretField
                  label="SIP password (optional)"
                  placeholder="paste password"
                  value={sip.password}
                  revealed={revealAuth}
                  onToggleReveal={() => setRevealAuth((v) => !v)}
                  onChange={(v) => setSip((s) => ({ ...s, password: v }))}
                  disabled={busy}
                />
              </>
            )}
          </div>

          {error && (
            <p className="border-t border-(--color-border) bg-(--color-panel) px-4 py-2 text-[11px] text-(--color-danger)">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-panel) px-4 py-2">
            <button
              type="button"
              disabled={busy}
              onClick={cancel}
              className="text-[12px] text-(--color-muted) transition hover:text-(--color-foreground-strong) disabled:opacity-50"
            >
              Cancel
            </button>
            <Button disabled={busy} onClick={submit}>
              {busy ? "Importing…" : "Import number"}
            </Button>
          </div>
        </>
      )}

    </div>
  );
}
