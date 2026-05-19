import { elFetch } from "../core/fetch";
import type { ElevenAgentBranch, ElevenAgentRaw, ElevenAgentVersion } from "./types";
import { getAgent } from "./crud";

/**
 * List the branches on an agent. We currently only care about `main`, but
 * the endpoint is the canonical way to discover its opaque id (the upstream
 * id is NOT the string "main") and to surface `most_recent_versions` for
 * the version-history panel.
 */
export async function listAgentBranches(
  agentId: string,
  opts?: { include_archived?: boolean; limit?: number },
): Promise<ElevenAgentBranch[]> {
  const qs = new URLSearchParams();
  qs.set("include_archived", String(opts?.include_archived ?? false));
  qs.set("limit", String(opts?.limit ?? 100));
  const res = await elFetch(
    `/v1/convai/agents/${agentId}/branches?${qs.toString()}`,
    { method: "GET", section: "branches" },
  );
  const json = (await res.json()) as
    | { results?: ElevenAgentBranch[] }
    | ElevenAgentBranch[];
  if (Array.isArray(json)) return json;
  return json.results ?? [];
}

/**
 * GET a single branch including its `most_recent_versions` array. Note:
 * the *list* endpoint returns AgentBranchSummary which does NOT include
 * versions — only this single-branch GET does (AgentBranchResponse).
 */
export async function getAgentBranch(
  agentId: string,
  branchId: string,
): Promise<ElevenAgentBranch> {
  const res = await elFetch(
    `/v1/convai/agents/${agentId}/branches/${branchId}`,
    { method: "GET", section: "branches" },
  );
  return (await res.json()) as ElevenAgentBranch;
}

/**
 * List the versions on a branch via the single-branch GET. ElevenLabs
 * doesn't expose a standalone "all versions" endpoint — the `most_recent_versions`
 * field on the branch is the canonical source.
 */
export async function listAgentVersions(
  agentId: string,
  branchId: string,
): Promise<ElevenAgentVersion[]> {
  const branch = await getAgentBranch(agentId, branchId);
  return branch.most_recent_versions ?? [];
}

/**
 * Fetch the agent config at a specific historical version. Returned shape
 * matches a normal GET /agents/{id} — i.e. ready for `projectAgentConfig`.
 */
export async function getAgentAtVersion(
  agentId: string,
  versionId: string,
): Promise<ElevenAgentRaw> {
  return getAgent(agentId, { version_id: versionId });
}
