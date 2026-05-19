import { elFetch } from "../core/fetch";

export type BatchCallRecipient = {
  phone_number: string;
  dynamic_variables?: Record<string, string>;
};

export async function submitBatchCall(input: {
  call_name: string;
  agent_id: string;
  agent_phone_number_id: string;
  recipients: BatchCallRecipient[];
  scheduled_time_unix?: number;
  target_concurrency_limit?: number;
}): Promise<{ id: string }> {
  const res = await elFetch("/v1/convai/batch-calling/submit", {
    method: "POST",
    section: "batch_calling",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      call_name: input.call_name,
      agent_id: input.agent_id,
      agent_phone_number_id: input.agent_phone_number_id,
      recipients: input.recipients,
      scheduled_time_unix: input.scheduled_time_unix,
      target_concurrency_limit: input.target_concurrency_limit,
    }),
  });
  return (await res.json()) as { id: string };
}

export async function getBatchCall(batchId: string): Promise<unknown> {
  const res = await elFetch(`/v1/convai/batch-calling/${batchId}`, {
    method: "GET",
    section: "batch_calling",
  });
  return res.json();
}

export async function cancelBatchCall(batchId: string): Promise<void> {
  await elFetch(`/v1/convai/batch-calling/${batchId}/cancel`, {
    method: "POST",
    section: "batch_calling",
  });
}
