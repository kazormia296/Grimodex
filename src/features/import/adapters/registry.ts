import type { ImportAdapter } from "./adapterTypes";
import { adapterKey } from "./adapterTypes";
import { scanImportAdapter } from "./scan/scanImportAdapter";
import { novelcrafterImportAdapter } from "./novelcrafter/novelcrafterImportAdapter";
import { markdownImportAdapter } from "./markdown/markdownImportAdapter";

const registry = new Map<string, ImportAdapter>();

export function registerImportAdapter(adapter: ImportAdapter): void {
  const key = adapterKey(adapter.descriptor.id, adapter.descriptor.version);
  if (registry.has(key)) {
    throw new Error(`Import adapter already registered: ${key}`);
  }
  registry.set(key, adapter);
}

export function getImportAdapter(
  id: string,
  version: string,
): ImportAdapter | undefined {
  return registry.get(adapterKey(id, version));
}

export function listImportAdapters(): readonly ImportAdapter["descriptor"][] {
  return [...registry.values()].map((a) => a.descriptor);
}

export function clearImportAdapterRegistryForTests(): void {
  registry.clear();
}

export function registerDefaultImportAdapters(): void {
  if (registry.size > 0) return;
  registerImportAdapter(scanImportAdapter);
  registerImportAdapter(novelcrafterImportAdapter);
  registerImportAdapter(markdownImportAdapter);
}

registerDefaultImportAdapters();
