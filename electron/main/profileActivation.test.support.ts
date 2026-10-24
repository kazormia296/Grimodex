/**
 * Test support of the profile activation (NIR-1 DA-2 ST2, D-7). Not part of
 * the product: nothing outside the tests imports it.
 *
 * * `consumedProfileActivationForTest` / `activateGateForTest`: a mocked
 *   Native consume, then the gate's stages 2 to 7. For the vitests whose
 *   backend is a mock (they check Main's gate, not Native's grant).
 * * `activateThroughMain`: the product's Main path with a real Native addon:
 *   the pre-publication entry is opened the way the journey seam opens it,
 *   and Main's controller runs preview → dialog (approved with the checkbox)
 *   → issue → consume → stages 2 to 7. For the pipeline specs.
 */
import type { NapiBackendLike } from "../shared/ipcContract.js";
import type { ProfileActivationRequestResult } from "../shared/profileEgressStatusWire.js";
import type { GrantSender, GrantWindow } from "./mainGrant.js";
import {
  createProfileActivationController,
  type ProfileActivationConfirm,
} from "./profileActivation.js";
import {
  consumeProfileActivation,
  type ConsumedProfileActivation,
  type ProfileEgressGate,
} from "./profileEgress.js";

export function consumedProfileActivationForTest(): ConsumedProfileActivation {
  return consumeProfileActivation(
    { profileActivationConsume: () => undefined },
    "grant-for-test",
    1,
    1,
  );
}

export function activateGateForTest(
  gate: ProfileEgressGate,
): ReturnType<NonNullable<ProfileEgressGate["beginProfileActivation"]>> {
  return gate.beginProfileActivation!(consumedProfileActivationForTest());
}

type Listener = (...args: unknown[]) => void;

/** A sender with the listener surface Main's confirmation uses. */
export function fakeGrantSender(id: number): GrantSender & {
  destroyed: boolean;
  emit(event: string, ...args: unknown[]): void;
} {
  const listeners = new Map<string, Set<Listener>>();
  return {
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return this;
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(...args);
      }
    },
  } as GrantSender & {
    destroyed: boolean;
    emit(event: string, ...args: unknown[]): void;
  };
}

export function fakeGrantWindow(id: number): GrantWindow & {
  destroyed: boolean;
  emit(event: string): void;
} {
  const listeners = new Map<string, Set<Listener>>();
  return {
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return this;
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    emit(event: string) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
  } as GrantWindow & { destroyed: boolean; emit(event: string): void };
}

export const approveWithCheckbox: ProfileActivationConfirm = async () => ({
  response: 1,
  checkboxChecked: true,
});

/**
 * The product's Main path against a real addon. The entry is opened here the
 * way the journey seam opens it (tests only; the product opens it only from
 * the seam, DR-DA2-10).
 */
export async function activateThroughMain(
  backend: NapiBackendLike,
  gate: ProfileEgressGate,
  {
    senderId = 1,
    windowId = 1,
    confirm = approveWithCheckbox,
    openGate = true,
  }: {
    senderId?: number;
    windowId?: number;
    confirm?: ProfileActivationConfirm;
    openGate?: boolean;
  } = {},
): Promise<ProfileActivationRequestResult> {
  if (openGate) backend.mainOpenPrePublicationGate!("profile-activation");
  const controller = createProfileActivationController({
    backend,
    gate,
    confirm,
  });
  const callerIdentity = gate.issueCallerIdentity(senderId);
  return controller.request({
    sender: fakeGrantSender(senderId),
    win: fakeGrantWindow(windowId),
    callerIdentity,
  });
}
