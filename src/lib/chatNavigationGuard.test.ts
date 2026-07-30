import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetChatNavigationGuardForTests,
  isChatNavigationBlocked,
  isTreeNavigationLeaseActive,
  setChatNavigationBlocker,
  tryAcquireChatAnchorDeletionLease,
  tryAcquireChatTurnAdmissionLease,
  tryAcquireTreeNavigationLease,
} from "./chatNavigationGuard";

describe("chatNavigationGuard", () => {
  beforeEach(() => {
    __resetChatNavigationGuardForTests();
  });

  afterEach(() => {
    __resetChatNavigationGuardForTests();
  });

  it("refuses Tree authority while Chat is active", () => {
    setChatNavigationBlocker(() => true);

    expect(tryAcquireTreeNavigationLease()).toBeNull();
    expect(isTreeNavigationLeaseActive()).toBe(false);
  });

  it("closes Chat admission for the full Tree navigation lease", () => {
    const tree = tryAcquireTreeNavigationLease();

    expect(tree).not.toBeNull();
    expect(isTreeNavigationLeaseActive()).toBe(true);
    expect(tryAcquireChatTurnAdmissionLease()).toBeNull();

    tree?.release();
    const chat = tryAcquireChatTurnAdmissionLease();
    expect(chat).not.toBeNull();
    chat?.release();
  });

  it("closes Tree admission before Chat publishes streaming state", () => {
    const chat = tryAcquireChatTurnAdmissionLease();

    expect(chat).not.toBeNull();
    expect(isChatNavigationBlocked()).toBe(true);
    expect(tryAcquireTreeNavigationLease()).toBeNull();

    chat?.release();
    const tree = tryAcquireTreeNavigationLease();
    expect(tree).not.toBeNull();
    tree?.release();
  });

  it("refuses anchor deletion while the Chat runtime blocker is active", () => {
    setChatNavigationBlocker(() => true);

    expect(tryAcquireChatAnchorDeletionLease()).toBeNull();
  });

  it("serializes anchor deletion and Chat preflight in both directions", () => {
    const deletion = tryAcquireChatAnchorDeletionLease();

    expect(deletion).not.toBeNull();
    expect(tryAcquireChatAnchorDeletionLease()).toBeNull();
    expect(tryAcquireChatTurnAdmissionLease()).toBeNull();

    deletion?.release();
    const chat = tryAcquireChatTurnAdmissionLease();
    expect(chat).not.toBeNull();
    expect(tryAcquireChatAnchorDeletionLease()).toBeNull();
    chat?.release();
  });
});
