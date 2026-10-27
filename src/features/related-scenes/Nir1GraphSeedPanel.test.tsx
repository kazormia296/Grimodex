// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebugLogStore } from "@/lib/debugLog";

const h = vi.hoisted(() => ({
  seed: vi.fn(),
  name: vi.fn(),
  candidates: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("./nir1GraphSeed", () => ({ selectNir1GraphSeed: h.seed }));
vi.mock("./nir1GraphSeedCandidates", () => ({
  readNir1GraphSeedEntryName: h.name,
  selectNir1GraphSeedCandidates: h.candidates,
}));
vi.mock("@/features/codex/sceneCodexPinsApi", () => ({
  upsertScenePin: h.upsert,
}));
import Nir1GraphSeedPanel from "./Nir1GraphSeedPanel";

const CANDIDATES = [
  { entryId: "e-pov", name: "アリス", reason: "pov" },
  { entryId: "e-act", name: "ボブ", reason: "beat-actor" },
  { entryId: "e-body", name: "王都", reason: "body" },
] as const;

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDebugLogStore.getState().clear();
  h.seed.mockResolvedValue(null);
  h.name.mockResolvedValue(null);
  h.candidates.mockResolvedValue(CANDIDATES);
  h.upsert.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
});

describe("Nir1GraphSeedPanel", () => {
  it("shows the name of the seed selectNir1GraphSeed picks, and reads no candidate", async () => {
    h.seed.mockResolvedValue("e-a");
    h.name.mockImplementation(async (_project: string, id: string) =>
      id === "e-a" ? "アリス" : null,
    );
    render(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={1}
        onPinned={vi.fn()}
      />,
    );
    await flush();

    expect(h.seed).toHaveBeenCalledWith("p", "s1");
    expect(h.name).toHaveBeenCalledWith("p", "e-a");
    expect(screen.getByTestId("nir1-graph-seed").textContent).toBe(
      "起点:アリス",
    );
    expect(h.candidates).not.toHaveBeenCalled();
    expect(screen.queryByTestId("nir1-graph-seed-candidates")).toBeNull();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("lists the candidates in order as a labelled list, and never pins by itself", async () => {
    render(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={1}
        onPinned={vi.fn()}
      />,
    );
    await flush();

    expect(h.candidates).toHaveBeenCalledWith("p", "s1");
    const section = screen.getByRole("region", { name: "起点の候補" });
    const items = within(section).getAllByRole("listitem");
    expect(
      items.map((item) => item.getAttribute("data-nir1-seed-reason")),
    ).toEqual(["pov", "beat-actor", "body"]);
    expect(
      within(section)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "アリス を起点にする",
      "ボブ を起点にする",
      "王都 を起点にする",
    ]);
    expect(within(items[0]!).getByText("視点人物")).toBeTruthy();
    await flush();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("pins the chosen entry once with the scene and entry ids, even when clicked twice", async () => {
    const write = deferred();
    h.upsert.mockReturnValue(write.promise);
    const onPinned = vi.fn();
    render(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={1}
        onPinned={onPinned}
      />,
    );
    await flush();

    const button = screen.getByRole("button", { name: "ボブ を起点にする" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "王都 を起点にする" }));
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledWith("s1", "e-act");
    expect(onPinned).not.toHaveBeenCalled();

    await act(async () => {
      write.resolve();
      await write.promise;
    });
    await flush();
    expect(onPinned).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps the candidates and tells the author when the pin cannot be written", async () => {
    h.upsert.mockRejectedValueOnce(new Error("db: secret text"));
    const onPinned = vi.fn();
    render(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={1}
        onPinned={onPinned}
      />,
    );
    await flush();

    fireEvent.click(
      screen.getByRole("button", { name: "アリス を起点にする" }),
    );
    await flush();

    expect(screen.getByRole("alert").textContent).toBe(
      "起点を保存できませんでした。もう一度お試しください。",
    );
    expect(screen.getAllByTestId("nir1-graph-seed-candidate")).toHaveLength(3);
    expect(onPinned).not.toHaveBeenCalled();
    expect(JSON.stringify(useDebugLogStore.getState().entries)).not.toContain(
      "secret",
    );

    // The author can try again.
    const retry = screen.getByRole("button", { name: "アリス を起点にする" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await flush();
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(onPinned).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says there is no seed when there is no candidate", async () => {
    h.candidates.mockResolvedValue([]);
    render(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={1}
        onPinned={vi.fn()}
      />,
    );
    await flush();

    expect(screen.getByRole("region", { name: "起点の候補" })).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.getByText(/起点がありません/)).toBeTruthy();
  });

  it("draws nothing when the read fails", async () => {
    h.seed.mockRejectedValueOnce(new Error("db down"));
    const { container } = render(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={1}
        onPinned={vi.fn()}
      />,
    );
    await flush();
    expect(container.textContent).toBe("");
    expect(
      useDebugLogStore
        .getState()
        .entries.filter((entry) => entry.tag === "related-scenes"),
    ).toEqual([]);
  });

  it("never shows the previous scene's seed while the next scene is read", async () => {
    h.seed.mockResolvedValueOnce("e-pov");
    h.name.mockResolvedValueOnce("アリス");
    const { container, rerender } = render(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={1}
        onPinned={vi.fn()}
      />,
    );
    await flush();
    expect(screen.getByTestId("nir1-graph-seed").textContent).toBe(
      "起点:アリス",
    );

    let finish!: (value: string) => void;
    h.seed.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    h.name.mockResolvedValueOnce("ボブ");
    rerender(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s2"
        queryGeneration={1}
        onPinned={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
    await act(async () => finish("e-act"));
    await flush();
    expect(screen.getByTestId("nir1-graph-seed").textContent).toBe("起点:ボブ");
  });

  it("reads again for a new query of the same scene, keeping the shown line meanwhile", async () => {
    h.seed.mockResolvedValueOnce(null);
    const { rerender } = render(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={1}
        onPinned={vi.fn()}
      />,
    );
    await flush();
    expect(screen.getAllByTestId("nir1-graph-seed-candidate")).toHaveLength(3);

    let finish!: (value: string) => void;
    h.seed.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    h.name.mockResolvedValueOnce("アリス");
    rerender(
      <Nir1GraphSeedPanel
        projectId="p"
        sceneId="s1"
        queryGeneration={2}
        onPinned={vi.fn()}
      />,
    );
    await flush();
    expect(h.seed).toHaveBeenCalledTimes(2);
    expect(screen.getAllByTestId("nir1-graph-seed-candidate")).toHaveLength(3);
    await act(async () => finish("e-pov"));
    await flush();
    expect(screen.getByTestId("nir1-graph-seed").textContent).toBe(
      "起点:アリス",
    );
  });
});
