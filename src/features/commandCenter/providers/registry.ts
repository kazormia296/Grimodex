import type { CommandCenterProvider } from "./types";

/**
 * Provider レジストリ。アプリ起動時に lexical/semantic を登録する。
 * module 局所 Map のため、テストは _clearProvidersForTests() でリセットする。
 */
const providers = new Map<string, CommandCenterProvider>();

export function registerProvider(provider: CommandCenterProvider): void {
  providers.set(provider.id, provider);
}

export function unregisterProvider(id: string): void {
  providers.delete(id);
}

export function getProviders(): CommandCenterProvider[] {
  return Array.from(providers.values()).sort((a, b) => a.order - b.order);
}

export function getProviderById(id: string): CommandCenterProvider | undefined {
  return providers.get(id);
}

/** Tests only — wipe registry between tests. */
export function _clearProvidersForTests(): void {
  providers.clear();
}
