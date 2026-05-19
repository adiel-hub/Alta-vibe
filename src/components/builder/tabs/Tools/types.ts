import type { RuntimePhase } from "@/types/agent";

export type CatalogTool = {
  key: string;
  name: string;
  description: string;
  phase: RuntimePhase;
  method: string;
  category: string;
  default_install: boolean;
  installed: boolean;
};

export type CatalogProvider = {
  id: string;
  name: string;
  description: string;
  icon: string;
  connected: boolean;
  tools: CatalogTool[];
};

export type FieldsMatcher = (fields: Array<string | undefined | null>) => boolean;

/**
 * Mode selector. `"manage"` (default) renders ToolsTab as the standalone
 * editor in the visual panel — install/uninstall buttons, full chrome.
 * `"pick"` repurposes the same UI as a tool picker (e.g. for the workflow
 * tool_call node): install/uninstall buttons disappear, clicking a tile
 * fires `onPick(tool)` with the installed RuntimeTool. If the picked tile
 * isn't installed yet we install it first, then call `onPick` with the
 * fresh entry — so the caller never has to deal with the install lifecycle.
 */
export type ToolsTabMode = "manage" | "pick";
