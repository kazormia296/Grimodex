import { listImportDecoders } from "./registryStorage";

export {
  clearImportDecoderRegistryForTests,
  getImportDecoder,
  listImportDecoders,
  registerImportDecoder,
} from "./registryStorage";

export function registerDefaultImportDecoders(): void {
  if (listImportDecoders().length > 0) return;
  // Side-effect registration via registerDefaults.ts
  void import("./registerDefaults");
}
