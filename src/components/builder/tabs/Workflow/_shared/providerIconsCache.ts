import { appFetch } from "@/lib/apiClient";

export type ProviderIconInfo = { icon: string; name: string };

export type DefaultMapping = {
  property: string;
  variable: string;
  /** True when the property can be remapped via dropdown (a real provider
   *  property); false for special paths like the record id. */
  mappable: boolean;
};
export type FieldMappingMeta = {
  object: string;
  defaults: DefaultMapping[];
};

type CatalogTool = {
  name: string;
  mappable_object?: string;
  default_field_mappings?: DefaultMapping[];
};
type CatalogProvider = {
  id: string;
  name: string;
  icon: string;
  tools?: CatalogTool[];
};

// Single module-level fetch of the provider catalog. The icon/name + each
// tool's mappable-object are workspace-static (only installed flags vary per
// agent), so we resolve once and derive the per-use maps. Mirrors voicesCache
// so we don't drag the whole Tools tab into Workflow.
let catalogPromise: Promise<CatalogProvider[]> | null = null;

function loadCatalogCached(agentId: string): Promise<CatalogProvider[]> {
  catalogPromise ??= appFetch(`/api/agents/${agentId}/provider-tools`).then(
    async (r) => {
      if (!r.ok) throw new Error(`Provider catalog request failed (${r.status})`);
      const j = (await r.json()) as { catalog: CatalogProvider[] };
      return j.catalog;
    },
  );
  return catalogPromise;
}

/** provider id → { icon, name } for rendering integration logos. */
export function loadProviderIconsCached(
  agentId: string,
): Promise<Map<string, ProviderIconInfo>> {
  return loadCatalogCached(agentId).then((catalog) => {
    const map = new Map<string, ProviderIconInfo>();
    for (const p of catalog) map.set(p.id, { icon: p.icon, name: p.name });
    return map;
  });
}

/**
 * scoped tool name → field-mapping meta (mappable object + built-in defaults).
 * Only tools whose spec declares `field_mapping` appear here; used to decide
 * whether to show the field-mapping editor, which object's properties to list,
 * and which default property→variable rows to display.
 */
export function loadFieldMappingMetaCached(
  agentId: string,
): Promise<Map<string, FieldMappingMeta>> {
  return loadCatalogCached(agentId).then((catalog) => {
    const map = new Map<string, FieldMappingMeta>();
    for (const p of catalog) {
      for (const t of p.tools ?? []) {
        if (t.mappable_object) {
          map.set(t.name, {
            object: t.mappable_object,
            defaults: t.default_field_mappings ?? [],
          });
        }
      }
    }
    return map;
  });
}
