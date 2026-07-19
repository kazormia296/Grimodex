import {
  supportsRuntimeCapability,
  type RuntimeCapabilities,
} from "./runtimeCapabilities";
import { runtimeTargets, type RuntimeTarget } from "./runtimeTarget";

/**
 * Reads the runtime target installed by the application bootstrap.
 *
 * Feature-level tests and legacy embedders do not necessarily run that
 * bootstrap. Treat an absent marker as the desktop-capable default so those
 * isolated surfaces keep their established behavior.
 */
export function readDocumentRuntimeTarget(): RuntimeTarget | null {
  if (typeof document === "undefined") return null;

  const candidate = document.documentElement.dataset.runtimeTarget;
  return runtimeTargets.includes(candidate as RuntimeTarget)
    ? (candidate as RuntimeTarget)
    : null;
}

export function supportsDocumentRuntimeCapability(
  capability: keyof RuntimeCapabilities,
): boolean {
  const target = readDocumentRuntimeTarget();
  return target === null || supportsRuntimeCapability(target, capability);
}
