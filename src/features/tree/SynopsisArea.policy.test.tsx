// @vitest-environment happy-dom
// 場面のあらすじの AI 生成は本文の提案（bodyWrite）の門を通る。
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generate = vi.hoisted(() => vi.fn(async () => "生成されたあらすじ"));
const update = vi.hoisted(() => vi.fn(async () => undefined));
const node = vi.hoisted(() => ({
  id: "s1",
  nodeType: "scene",
  title: "場面",
  synopsis: "" as string,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));
vi.mock("./api", () => ({ loadSceneContent: vi.fn(async () => "本文") }));
vi.mock("@/lib/prosemirror", () => ({ prosemirrorToText: () => "本文" }));
vi.mock("@/features/chat/chatApi", () => ({
  generateSynopsisFromContent: generate,
}));
vi.mock("@/features/editor/InlineSynopsisEditor", () => ({
  InlineSynopsisEditor: () => null,
}));
vi.mock("./treeStore", () => ({
  useTreeStore: (select: (s: unknown) => unknown) =>
    select({ nodes: [node], updateSynopsis: update }),
}));

import { useProjectStore } from "@/features/project/projectStore";
import { setAiProviderReady } from "@/test-utils/aiProviderReady";
import { SynopsisArea } from "./SynopsisArea";

const policy = (bodyWrite: boolean) =>
  JSON.stringify({
    preset: "custom",
    toggles: {
      chat: true,
      bodyWrite,
      analysis: true,
      structureWrite: false,
      knowledgeWrite: false,
    },
  });
const setPolicy = (aiPolicy: string) =>
  useProjectStore.setState({
    currentProjectId: "p1",
    projects: [{ id: "p1", aiPolicy } as never],
  });
const generateButton = () => screen.queryByTitle("tree.synopsis.generateTitle");

beforeEach(() => {
  generate.mockClear();
  update.mockClear();
  node.synopsis = "";
  setAiProviderReady();
});

describe("SynopsisArea AI generation and the AI policy", () => {
  it.each([
    ["bodyWrite off", policy(false)],
    ["a damaged policy", "not-json"],
  ])("hides the control with %s", (_label, aiPolicy) => {
    setPolicy(aiPolicy);
    render(<SynopsisArea nodeId="s1" />);
    expect(generateButton()).toBeNull();
  });

  it("generates and saves with bodyWrite on", async () => {
    setPolicy(policy(true));
    render(<SynopsisArea nodeId="s1" />);
    fireEvent.click(generateButton() as HTMLElement);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("s1", "生成されたあらすじ"),
    );
  });

  it("does not generate from the overwrite button once the policy turns off", async () => {
    node.synopsis = "今のあらすじ";
    setPolicy(policy(true));
    render(<SynopsisArea nodeId="s1" />);
    fireEvent.click(generateButton() as HTMLElement);
    const overwrite = await screen.findByText("tree.synopsis.overwrite");
    act(() => setPolicy(policy(false)));
    fireEvent.click(overwrite);
    await Promise.resolve();
    expect(generate).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("does not save a synopsis when the policy turns off during generation", async () => {
    setPolicy(policy(true));
    generate.mockImplementationOnce(async () => {
      act(() => setPolicy(policy(false)));
      return "生成されたあらすじ";
    });
    render(<SynopsisArea nodeId="s1" />);
    fireEvent.click(generateButton() as HTMLElement);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(update).not.toHaveBeenCalled();
  });
});
