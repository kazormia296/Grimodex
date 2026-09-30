import type { Transaction } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";
import {
  createLoadedMiniEditorTimelapseAuthority,
  recordMiniEditorTransaction,
  type MiniEditorTimelapsePorts,
} from "./miniEditorTimelapse";

function transaction(
  docChanged: boolean,
  steps: unknown[] = [{ stepType: "replace", from: 1, to: 1 }],
): Transaction {
  return {
    docChanged,
    steps: steps.map((step) => ({ toJSON: () => step })),
  } as unknown as Transaction;
}

function ports(): MiniEditorTimelapsePorts {
  return {
    recordChangeEvent: vi.fn(),
    reportCaptureFailure: vi.fn(),
  };
}

describe("recordMiniEditorTransaction", () => {
  it.each([
    {
      documentKey: { kind: "codex", id: "codex-1", phaseId: null } as const,
      domain: "codex",
      entityType: "codex_entry",
    },
    {
      documentKey: { kind: "snippet", id: "snippet-1" } as const,
      domain: "snippet",
      entityType: "snippet",
    },
  ])(
    "records one project-scoped $domain event for one transaction",
    ({ documentKey, domain, entityType }) => {
      const capturePorts = ports();
      const authority = createLoadedMiniEditorTimelapseAuthority(
        "project-loaded",
        documentKey,
      );

      recordMiniEditorTransaction(
        {
          transaction: transaction(true, [
            { stepType: "replace", from: 1, to: 1 },
            { stepType: "addMark", from: 1, to: 2 },
          ]),
          authority,
          isApplyingExternalUpdate: false,
        },
        capturePorts,
      );

      expect(capturePorts.recordChangeEvent).toHaveBeenCalledOnce();
      expect(capturePorts.recordChangeEvent).toHaveBeenCalledWith({
        domain,
        opType: "doc.step",
        projectId: "project-loaded",
        sceneId: null,
        entityType,
        entityId: documentKey.id,
        payload: {
          steps: [
            { stepType: "replace", from: 1, to: 1 },
            { stepType: "addMark", from: 1, to: 2 },
          ],
        },
      });
    },
  );

  it("does not capture hydration, external replacement, or Codex Phase bodies", () => {
    const capturePorts = ports();
    const base = createLoadedMiniEditorTimelapseAuthority("project-1", {
      kind: "codex",
      id: "codex-1",
      phaseId: null,
    });
    const phase = createLoadedMiniEditorTimelapseAuthority("project-1", {
      kind: "codex",
      id: "codex-1",
      phaseId: "phase-1",
    });

    recordMiniEditorTransaction(
      {
        transaction: transaction(false),
        authority: base,
        isApplyingExternalUpdate: false,
      },
      capturePorts,
    );
    recordMiniEditorTransaction(
      {
        transaction: transaction(true),
        authority: base,
        isApplyingExternalUpdate: true,
      },
      capturePorts,
    );
    recordMiniEditorTransaction(
      {
        transaction: transaction(true),
        authority: phase,
        isApplyingExternalUpdate: false,
      },
      capturePorts,
    );

    expect(capturePorts.recordChangeEvent).not.toHaveBeenCalled();
  });

  it("reports capture serialization failures without interrupting editing", () => {
    const capturePorts = ports();
    const error = new Error("step serialization failed");
    const broken = {
      docChanged: true,
      steps: [
        {
          toJSON: () => {
            throw error;
          },
        },
      ],
    } as unknown as Transaction;

    expect(() =>
      recordMiniEditorTransaction(
        {
          transaction: broken,
          authority: createLoadedMiniEditorTimelapseAuthority("project-1", {
            kind: "snippet",
            id: "snippet-1",
          }),
          isApplyingExternalUpdate: false,
        },
        capturePorts,
      ),
    ).not.toThrow();
    expect(capturePorts.reportCaptureFailure).toHaveBeenCalledWith(error);
  });
});
