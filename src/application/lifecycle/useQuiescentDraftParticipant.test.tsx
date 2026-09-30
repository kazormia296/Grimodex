// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetQuiescenceParticipantsForTests,
  collectQuiescenceParticipantRecovery,
  flushQuiescenceParticipants,
  flushQuiescenceParticipantsForScopes,
} from "./quiescenceParticipants";
import {
  useQuiescentDraftParticipant,
  type QuiescentDraftParticipantOptions,
} from "./useQuiescentDraftParticipant";
import { useLatestValueDraftController } from "./latestValueDraftController";

describe("useQuiescentDraftParticipant", () => {
  beforeEach(() => {
    _resetQuiescenceParticipantsForTests();
  });

  afterEach(() => {
    _resetQuiescenceParticipantsForTests();
  });

  it("flushes the latest draft callback without re-registering per keystroke", async () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const latest = vi.fn().mockResolvedValue(undefined);
    const base = {
      id: "title:scene-1",
      enabled: true,
      isDirty: () => true,
      discard: vi.fn(),
      recovery: () => ({ text: "latest" }),
    } satisfies Omit<QuiescentDraftParticipantOptions, "flush">;
    const { rerender } = renderHook(
      ({ flush }: { flush: () => Promise<void> }) =>
        useQuiescentDraftParticipant({ ...base, flush }),
      { initialProps: { flush: first } },
    );

    rerender({ flush: latest });
    await flushQuiescenceParticipants();

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it("flushes only dirty participants in the requested entity scope", async () => {
    let sceneADirty = true;
    let sceneBDirty = true;
    const flushA = vi.fn(async () => {
      sceneADirty = false;
    });
    const flushB = vi.fn(async () => {
      sceneBDirty = false;
    });
    renderHook(() => {
      useQuiescentDraftParticipant({
        id: "title:scene-a",
        enabled: true,
        scope: { kind: "tree-node", entityId: "scene-a" },
        isDirty: () => sceneADirty,
        flush: flushA,
        discard: () => {
          sceneADirty = false;
        },
      });
      useQuiescentDraftParticipant({
        id: "title:scene-b",
        enabled: true,
        scope: { kind: "tree-node", entityId: "scene-b" },
        isDirty: () => sceneBDirty,
        flush: flushB,
        discard: () => {
          sceneBDirty = false;
        },
      });
    });

    await flushQuiescenceParticipantsForScopes([
      { kind: "tree-node", entityId: "scene-b" },
    ]);

    expect(flushA).not.toHaveBeenCalled();
    expect(flushB).toHaveBeenCalledOnce();
  });

  it("retains a detached failed draft for recovery and strict retry", async () => {
    let dirty = true;
    const flush = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementationOnce(async () => {
        dirty = false;
      });
    const { unmount } = renderHook(() =>
      useQuiescentDraftParticipant({
        id: "beat:scene-1",
        enabled: true,
        isDirty: () => dirty,
        flush,
        discard: () => {
          dirty = false;
        },
        recovery: () => (dirty ? { text: "uncommitted" } : null),
      }),
    );

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(collectQuiescenceParticipantRecovery()).toEqual([
      { text: "uncommitted" },
    ]);

    await flushQuiescenceParticipants();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(collectQuiescenceParticipantRecovery()).toEqual([]);
  });

  it("preserves a synchronous flush error and clears the in-flight slot for retry", async () => {
    let dirty = true;
    const flush = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("synchronous persistence failure");
      })
      .mockImplementationOnce(async () => {
        dirty = false;
      });
    renderHook(() =>
      useQuiescentDraftParticipant({
        id: "title:sync-throw",
        enabled: true,
        isDirty: () => dirty,
        flush,
        discard: () => {
          dirty = false;
        },
      }),
    );

    const failure = await flushQuiescenceParticipants().catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toEqual(
      new Error("synchronous persistence failure"),
    );

    await expect(flushQuiescenceParticipants()).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("isolates a failed EditorPane title draft from the replacement document identity", async () => {
    const persistA = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const persistB = vi.fn<(value: string) => Promise<void>>();
    const { result, rerender } = renderHook(
      ({
        documentId,
        editingDocumentId,
      }: {
        documentId: "a" | "b";
        editingDocumentId: "a" | "b";
      }) => {
        const controller = useLatestValueDraftController<string>(
          `editor-title:${documentId}`,
          documentId === "a" ? "Title A" : "Title B",
          documentId === "a" ? persistA : persistB,
        );
        useQuiescentDraftParticipant({
          id: `editor-title:${documentId}`,
          enabled: editingDocumentId === documentId,
          isDirty: () => controller.dirty,
          flush: (options) => controller.save(options),
          discard: () =>
            controller.reset(documentId === "a" ? "Title A" : "Title B"),
          recovery: () =>
            controller.dirty
              ? {
                  kind: "editor-title",
                  documentId,
                  title: controller.latestValue,
                }
              : null,
        });
        return controller;
      },
      {
        initialProps: {
          documentId: "a",
          editingDocumentId: "a",
        } as {
          documentId: "a" | "b";
          editingDocumentId: "a" | "b";
        },
      },
    );

    act(() => result.current.markDirty("Unsaved A"));
    await act(async () => {
      rerender({
        documentId: "b",
        // Mirrors EditorPane: the stale edit identity does not enable a
        // participant for the replacement document.
        editingDocumentId: "a",
      });
      await Promise.resolve();
    });

    expect(collectQuiescenceParticipantRecovery()).toEqual([
      {
        kind: "editor-title",
        documentId: "a",
        title: "Unsaved A",
      },
    ]);
    await flushQuiescenceParticipants();

    expect(persistA.mock.calls.map(([value]) => value)).toEqual([
      "Unsaved A",
      "Unsaved A",
    ]);
    expect(persistB).not.toHaveBeenCalled();
    expect(collectQuiescenceParticipantRecovery()).toEqual([]);
  });
});
