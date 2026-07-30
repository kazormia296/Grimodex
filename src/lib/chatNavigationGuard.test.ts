import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetChatNavigationGuardForTests,
  isChatNavigationBlocked,
  isChatSceneTransitionBlocked,
  isTreeNavigationLeaseActive,
  setChatNavigationBlocker,
  setChatSceneTransitionBlocker,
  tryAcquireChatAnchorDeletionLease,
  tryAcquireChatTurnAdmissionLease,
  tryAcquireTreeCreationLease,
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

  it("allows non-destructive Tree creation after Chat preflight is published", () => {
    setChatNavigationBlocker(() => true);

    const creation = tryAcquireTreeCreationLease();

    expect(creation).not.toBeNull();
    expect(isTreeNavigationLeaseActive()).toBe(true);
    creation?.release();
  });

  it("keeps Scene creation and selection blocked for sticky persistence", () => {
    setChatNavigationBlocker(() => true);
    setChatSceneTransitionBlocker(() => true);

    expect(isChatSceneTransitionBlocked()).toBe(true);
    expect(tryAcquireTreeCreationLease()).toBeNull();
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
    expect(tryAcquireTreeCreationLease()).toBeNull();

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
