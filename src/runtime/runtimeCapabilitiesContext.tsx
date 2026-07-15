import { createContext, useContext, type ReactNode } from "react";
import {
  resolveRuntimeCapabilities,
  type RuntimeCapabilities,
} from "./runtimeCapabilities";
import type { RuntimeTarget } from "./runtimeTarget";

const RuntimeCapabilitiesContext = createContext<RuntimeCapabilities | null>(
  null,
);

export function RuntimeCapabilitiesProvider({
  target,
  children,
}: {
  target: RuntimeTarget;
  children: ReactNode;
}) {
  return (
    <RuntimeCapabilitiesContext.Provider
      value={resolveRuntimeCapabilities(target)}
    >
      {children}
    </RuntimeCapabilitiesContext.Provider>
  );
}

export function useRuntimeCapabilities(): RuntimeCapabilities {
  return (
    useContext(RuntimeCapabilitiesContext) ?? resolveRuntimeCapabilities("web")
  );
}

export function CapabilityGate({
  capability,
  children,
  fallback = null,
}: {
  capability: keyof RuntimeCapabilities;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const configuredCapabilities = useContext(RuntimeCapabilitiesContext);
  // Isolated feature tests and legacy embedders may render a leaf without the
  // app provider. The application root always supplies the provider, so keep
  // the leaf visible in that unconfigured case rather than silently deleting
  // its controls.
  return configuredCapabilities === null || configuredCapabilities[capability]
    ? children
    : fallback;
}
