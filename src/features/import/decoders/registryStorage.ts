import type { ImportDecoder } from "./decoderTypes";
import { decoderKey } from "./decoderTypes";

const registry = new Map<string, ImportDecoder>();

export function registerImportDecoder(decoder: ImportDecoder): void {
  const key = decoderKey(decoder.descriptor.id, decoder.descriptor.version);
  if (registry.has(key)) {
    throw new Error(`Import decoder already registered: ${key}`);
  }
  registry.set(key, decoder);
}

export function getImportDecoder(
  id: string,
  version: string,
): ImportDecoder | undefined {
  return registry.get(decoderKey(id, version));
}

export function listImportDecoders(): readonly ImportDecoder["descriptor"][] {
  return [...registry.values()].map((decoder) => decoder.descriptor);
}

export function clearImportDecoderRegistryForTests(): void {
  registry.clear();
}
