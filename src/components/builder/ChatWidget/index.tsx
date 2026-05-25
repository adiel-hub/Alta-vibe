"use client";

import type { WidgetEntry } from "@/store/agentStore";
import { ConnectIntegrationWidget } from "./ConnectIntegration";
import { ConfirmWidget } from "./Confirm";
import { PickOptionWidget } from "./PickOption";
import { CollectSecretWidget } from "./CollectSecret";
import { PhoneNumberSetupWidget } from "./PhoneNumberSetup";
import { SelectProspectsWidget } from "./SelectProspects";
import { AudienceSourcePickerWidget } from "./AudienceSourcePicker";
import { CsvUploadWidget } from "./CsvUpload";

export function ChatWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  if (widget.kind === "connect_integration") {
    return <ConnectIntegrationWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "confirm") {
    return <ConfirmWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "pick_option") {
    return <PickOptionWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "collect_secret") {
    return <CollectSecretWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "phone_number_setup") {
    return <PhoneNumberSetupWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "select_prospects") {
    return <SelectProspectsWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "audience_source_picker") {
    return <AudienceSourcePickerWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "csv_upload") {
    return <CsvUploadWidget agentId={agentId} widget={widget} />;
  }
  return null;
}
