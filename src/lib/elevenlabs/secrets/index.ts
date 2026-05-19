import { elFetch } from "../core/fetch";

export async function createWorkspaceSecret(input: {
  name: string;
  value: string;
}): Promise<{ id: string; name: string }> {
  const res = await elFetch("/v1/convai/secrets", {
    method: "POST",
    section: "secrets",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, value: input.value, type: "new" }),
  });
  return (await res.json()) as { id: string; name: string };
}

export async function listWorkspaceSecrets(): Promise<
  Array<{ id: string; name: string }>
> {
  const res = await elFetch("/v1/convai/secrets", {
    method: "GET",
    section: "secrets",
  });
  const json = (await res.json()) as {
    secrets: Array<{ secret_id: string; name: string }>;
  };
  return json.secrets.map((s) => ({ id: s.secret_id, name: s.name }));
}
