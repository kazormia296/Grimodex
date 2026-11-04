import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ createNewProject: vi.fn() }));
vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ createNewProject: h.createNewProject }),
  },
}));

import { prepareImportTarget } from "./importTarget";

describe("取り込みで作る project（SDEF/1 R12、PR-2 review P2-4）", () => {
  it("creates the new project without the main-line check, so it has no default", async () => {
    await prepareImportTarget("newProject", { title: "Imported novel" });
    expect(h.createNewProject).toHaveBeenCalledTimes(1);
    const input = h.createNewProject.mock.calls[0]![0];
    expect(Object.hasOwn(input, "sceneScopeMainLine")).toBe(false);
    // projectStore.test.ts fixes that such an input sends no
    // `sceneScopeDefault` to the Native create.
  });
});
