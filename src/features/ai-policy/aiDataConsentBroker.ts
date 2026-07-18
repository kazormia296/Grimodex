import type { AiDataDisclosureView } from "./AiDataConsentDialog";
import {
  createAiDataConsentRecord,
  isAiDataConsentCurrent,
  type AiDataConsentRecord,
} from "./aiDataConsent";

const STORAGE_KEY = "grimodex:ai-data-consents/v1";

type StoredConsentRecord = AiDataConsentRecord;

export interface ActiveAiDataConsentRequest {
  disclosure: AiDataDisclosureView;
}

interface PendingRequest extends ActiveAiDataConsentRequest {
  resolve: () => void;
  reject: (cause: Error) => void;
}

type Listener = () => void;

let active: PendingRequest | null = null;
const queue: PendingRequest[] = [];
const listeners = new Set<Listener>();

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readRecords(): StoredConsentRecord[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isStoredConsentRecord) : [];
  } catch {
    return [];
  }
}

function isStoredConsentRecord(value: unknown): value is StoredConsentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.policyVersion === "string" &&
    (record.route === "scan" ||
      record.route === "hosted-editor" ||
      record.route === "byok") &&
    typeof record.provider === "string" &&
    typeof record.acceptedAt === "string" &&
    Number.isFinite(Date.parse(record.acceptedAt))
  );
}

function isCurrent(
  record: StoredConsentRecord,
  disclosure: AiDataDisclosureView,
): boolean {
  return isAiDataConsentCurrent(record, disclosure);
}

function hasCurrentConsent(disclosure: AiDataDisclosureView): boolean {
  return readRecords().some((record) => isCurrent(record, disclosure));
}

function persistConsent(disclosure: AiDataDisclosureView): boolean {
  const records = readRecords().filter(
    (record) =>
      !(
        record.route === disclosure.route &&
        record.provider === disclosure.provider
      ),
  );
  records.push(createAiDataConsentRecord(disclosure));
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch {
    // The explicit acceptance still authorizes this one pending request. When
    // storage is unavailable (for example in a restricted privacy mode), the
    // next request asks again instead of leaving the current request pending.
    return false;
  }
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function activateNext(): void {
  if (active) return;
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) return;
    if (hasCurrentConsent(next.disclosure)) {
      next.resolve();
      continue;
    }
    active = next;
    notify();
    return;
  }
  notify();
}

/**
 * Authorizes one AI call. Only disclosure identity and acceptance time are
 * stored locally; prompts, responses, and API keys are never written here.
 */
export function requestAiDataConsent(
  disclosure: AiDataDisclosureView,
): Promise<void> {
  if (hasCurrentConsent(disclosure)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    queue.push({ disclosure, resolve, reject });
    activateNext();
  });
}

export function getActiveAiDataConsentRequest(): ActiveAiDataConsentRequest | null {
  // useSyncExternalStore requires referentially stable snapshots until a
  // notification. PendingRequest already structurally contains the public
  // request shape, so return that stable object instead of allocating here.
  return active;
}

export function subscribeAiDataConsent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function acceptActiveAiDataConsent(consentId: string): void {
  if (!active || active.disclosure.consentId !== consentId) return;
  const accepted = active;
  active = null;
  persistConsent(accepted.disclosure);
  accepted.resolve();
  activateNext();
}

export function declineActiveAiDataConsent(): void {
  if (!active) return;
  const declined = active;
  active = null;
  declined.reject(new Error("ai-data-consent-required"));
  activateNext();
}
