import { elFetch } from "../core/fetch";

export async function simulateConversation(input: {
  agent_id: string;
  simulation_specification: {
    simulated_user_config: { first_message?: string; prompt: string };
  };
}): Promise<unknown> {
  const res = await elFetch(
    `/v1/convai/agents/${input.agent_id}/simulate-conversation`,
    {
      method: "POST",
      section: "simulation",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        simulation_specification: input.simulation_specification,
      }),
    },
  );
  return res.json();
}
