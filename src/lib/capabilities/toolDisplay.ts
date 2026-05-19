/**
 * Mapping from raw MCP tool name → friendly user-facing label + emoji.
 * Used by the chat to show a single one-line indicator that morphs as
 * each tool fires, instead of dumping raw tool_use JSON.
 *
 * Add a new entry whenever you add a new tool. Unknown tools fall back
 * to a humanised version of the name.
 */
const MAP: Record<string, { emoji: string; label: string }> = {
  // identity
  update_agent_name: { emoji: "🏷️", label: "Renaming the agent" },
  update_first_message: { emoji: "👋", label: "Polishing the greeting" },
  update_system_prompt: { emoji: "📝", label: "Writing the system prompt" },
  // voice
  update_voice: { emoji: "🎙️", label: "Setting the voice" },
  update_voice_settings: { emoji: "🎚️", label: "Tuning voice expression" },
  list_tts_models: { emoji: "🧠", label: "Checking voice models" },
  update_tts_model: { emoji: "🧠", label: "Setting the voice model" },
  update_language: { emoji: "🌐", label: "Setting the language" },
  // llm
  update_llm_settings: { emoji: "✨", label: "Configuring the brain" },
  update_max_call_duration: { emoji: "⏱️", label: "Setting call limits" },
  // knowledge base
  add_knowledge_base_url: { emoji: "🔗", label: "Indexing a URL" },
  add_knowledge_base_text: { emoji: "📄", label: "Writing a knowledge note" },
  read_website: { emoji: "👀", label: "Reading the site" },
  scrape_website_to_knowledge_base: { emoji: "🕸️", label: "Crawling the site" },
  scrape_single_page_to_knowledge_base: { emoji: "🕸️", label: "Scraping the page" },
  remove_knowledge_base_document: { emoji: "🗑️", label: "Removing a document" },
  rename_knowledge_base_document: { emoji: "✏️", label: "Renaming a document" },
  // runtime tools
  create_custom_runtime_tool: { emoji: "🛠️", label: "Building a runtime tool" },
  remove_runtime_tool: { emoji: "🗑️", label: "Removing a runtime tool" },
  write_tool: { emoji: "🛠️", label: "Synthesizing a tool" },
  delete_custom_tool: { emoji: "🗑️", label: "Deleting a custom tool" },
  // mcp
  add_mcp_integration: { emoji: "🔌", label: "Connecting an MCP server" },
  remove_mcp_integration: { emoji: "🔌", label: "Disconnecting an MCP server" },
  // post-call
  add_data_collection_field: { emoji: "📊", label: "Adding a data field" },
  update_data_collection_field: { emoji: "📊", label: "Updating a data field" },
  remove_data_collection_field: { emoji: "📊", label: "Removing a data field" },
  add_call_outcome: { emoji: "🎯", label: "Adding a call outcome" },
  update_call_outcome: { emoji: "🎯", label: "Updating a call outcome" },
  remove_call_outcome: { emoji: "🎯", label: "Removing a call outcome" },
  // Legacy aliases — older chat turns persisted these tool names before we
  // renamed them. Keep the same emoji/label so historical messages render
  // consistently with current ones ("call outcome", not "evaluation criterion").
  add_evaluation_criterion: { emoji: "🎯", label: "Adding a call outcome" },
  update_evaluation_criterion: { emoji: "🎯", label: "Updating a call outcome" },
  remove_evaluation_criterion: { emoji: "🎯", label: "Removing a call outcome" },
  // telephony
  list_phone_numbers: { emoji: "☎️", label: "Listing phone numbers" },
  assign_phone_number_to_agent: { emoji: "☎️", label: "Attaching a phone number" },
  place_outbound_test_call: { emoji: "📞", label: "Placing a test call" },
  list_recent_calls: { emoji: "📒", label: "Reading the call log" },
  get_call_details: { emoji: "📒", label: "Looking at a call" },
  setup_phone_number: { emoji: "📲", label: "Importing a phone number" },
  get_phone_number: { emoji: "☎️", label: "Reading a phone number" },
  update_phone_number: { emoji: "☎️", label: "Updating a phone number" },
  delete_phone_number: { emoji: "🗑️", label: "Deleting a phone number" },
  get_phone_number_sip_messages: { emoji: "📡", label: "Reading SIP messages" },
  // workflow
  set_workflow: { emoji: "🌊", label: "Designing the workflow" },
  edit_workflow: { emoji: "✏️", label: "Editing the workflow" },
  workflow_reset: { emoji: "♻️", label: "Resetting the workflow" },
  // widgets / integrations
  list_integration_providers: { emoji: "🧩", label: "Browsing integrations" },
  request_user_action: { emoji: "💬", label: "Waiting for your input" },
  list_connected_integrations: { emoji: "🧩", label: "Listing connections" },
  disconnect_integration: { emoji: "🔌", label: "Disconnecting an integration" },
};

export type FriendlyToolDisplay = { emoji: string; label: string };

export function friendlyForTool(rawName: string): FriendlyToolDisplay {
  const name = rawName.replace(/^mcp__alta__/, "");
  if (MAP[name]) return MAP[name];
  // Fallback: humanise snake_case
  const label =
    name.charAt(0).toUpperCase() +
    name.slice(1).replace(/_/g, " ");
  return { emoji: "⚙️", label };
}
