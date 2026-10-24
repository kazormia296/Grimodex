// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OpenaiCompatibleEndpointsManager } from "./OpenaiCompatibleEndpointsManager";
import type { OpenaiCompatibleEndpoint } from "@/features/chat/types";
import { rootCause } from "@/lib/debugLog";

// i18n は key をそのまま返すモック（メッセージ文言ではなく挙動を検証する）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const { hasApiKey, deleteApiKey, saveApiKey, testAiConnection } = vi.hoisted(
  () => ({
    hasApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    saveApiKey: vi.fn(),
    testAiConnection: vi.fn(),
  }),
);

vi.mock("@/features/chat/api", () => ({
  hasApiKey: (...a: unknown[]) => hasApiKey(...a),
  deleteApiKey: (...a: unknown[]) => deleteApiKey(...a),
  saveApiKey: (...a: unknown[]) => saveApiKey(...a),
  testAiConnection: (...a: unknown[]) => testAiConnection(...a),
  listAiModels: vi.fn().mockResolvedValue([]),
}));

const EP: OpenaiCompatibleEndpoint = {
  id: "default",
  label: "",
  baseUrl: "http://localhost:1234/v1",
  apiVariant: null,
};

const EP2: OpenaiCompatibleEndpoint = {
  id: "second",
  label: "second",
  baseUrl: "http://localhost:5678/v1",
  apiVariant: null,
};

describe("OpenaiCompatibleEndpointsManager — key delete error feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an error message (and does not crash silently) when deleteApiKey rejects", async () => {
    // キー設定済み表示にする。
    hasApiKey.mockResolvedValue(true);
    deleteApiKey.mockRejectedValue(new Error("Keyring error: boom"));

    render(
      <OpenaiCompatibleEndpointsManager
        endpoints={[EP]}
        activeId="default"
        onChange={() => {}}
      />,
    );

    // 「キー削除」ボタンが現れるまで待つ（hasApiKey=true）。
    const delBtn = await screen.findByText("settings.ai.deleteKey");
    fireEvent.click(delBtn);

    // 失敗時にエラーメッセージが画面へ出ること（握りつぶさない）。
    await waitFor(() => {
      expect(screen.getByText(/Keyring error: boom/)).toBeInTheDocument();
    });
  });
});

describe("OpenaiCompatibleEndpointsManager — key presence fetching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mount で全 endpoint 分を 1 回だけ取得し、同一 id の再レンダーでは再取得しない", async () => {
    hasApiKey.mockResolvedValue(false);
    const { rerender } = render(
      <OpenaiCompatibleEndpointsManager
        endpoints={[EP, EP2]}
        activeId="default"
        onChange={() => {}}
      />,
    );
    await waitFor(() => expect(hasApiKey).toHaveBeenCalledTimes(2));

    // label 編集相当: endpoints の参照は変わるが id 集合は同じ。
    rerender(
      <OpenaiCompatibleEndpointsManager
        endpoints={[{ ...EP, label: "renamed" }, EP2]}
        activeId="default"
        onChange={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByPlaceholderText("sk-...")).toHaveLength(2),
    );
    expect(hasApiKey).toHaveBeenCalledTimes(2);
  });

  it("新しい id が増えたらその endpoint の分だけ追加取得する", async () => {
    hasApiKey.mockResolvedValue(false);
    const { rerender } = render(
      <OpenaiCompatibleEndpointsManager
        endpoints={[EP]}
        activeId="default"
        onChange={() => {}}
      />,
    );
    await waitFor(() => expect(hasApiKey).toHaveBeenCalledTimes(1));

    rerender(
      <OpenaiCompatibleEndpointsManager
        endpoints={[EP, EP2]}
        activeId="default"
        onChange={() => {}}
      />,
    );
    await waitFor(() => expect(hasApiKey).toHaveBeenCalledTimes(2));
    expect(hasApiKey).toHaveBeenLastCalledWith("openai-compatible", "second");
  });

  it("キー保存の成功時は hasApiKey を撃ち直さずキー有り表示へ切り替える", async () => {
    hasApiKey.mockResolvedValue(false);
    saveApiKey.mockResolvedValue(undefined);
    render(
      <OpenaiCompatibleEndpointsManager
        endpoints={[EP]}
        activeId="default"
        onChange={() => {}}
      />,
    );
    const input = await screen.findByPlaceholderText("sk-...");
    fireEvent.change(input, { target: { value: "sk-test" } });
    fireEvent.click(screen.getByText("settings.ai.saveKey"));

    await screen.findByText("settings.ai.keySet");
    expect(saveApiKey).toHaveBeenCalledWith(
      "openai-compatible",
      "sk-test",
      "default",
    );
    expect(hasApiKey).toHaveBeenCalledTimes(1);
  });

  it("キー削除の成功時は hasApiKey を撃ち直さずキー未設定表示へ戻す", async () => {
    hasApiKey.mockResolvedValue(true);
    deleteApiKey.mockResolvedValue(undefined);
    render(
      <OpenaiCompatibleEndpointsManager
        endpoints={[EP]}
        activeId="default"
        onChange={() => {}}
      />,
    );
    const delBtn = await screen.findByText("settings.ai.deleteKey");
    fireEvent.click(delBtn);

    await screen.findByPlaceholderText("sk-...");
    expect(hasApiKey).toHaveBeenCalledTimes(1);
  });
});

// DA-2b (Negative (11); DR-DA2B-R5): a D2a refusal of the connection test is
// not a connection failure: the result is the generic text, never the raw
// marker and route.
describe("OpenaiCompatibleEndpointsManager — a D2a refusal of the test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the generic text instead of the marker", async () => {
    const denial = new Error(
      "D2A_EGRESS_DENIED: external-url: route test_ai_connection is unavailable in profile local-only mode",
    );
    hasApiKey.mockResolvedValue(true);
    testAiConnection.mockRejectedValue(denial);

    render(
      <OpenaiCompatibleEndpointsManager
        endpoints={[EP]}
        activeId="default"
        onChange={() => {}}
      />,
    );
    fireEvent.click(await screen.findByText("settings.ai.testConnection"));

    expect(await screen.findByText(rootCause(denial))).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("D2A_EGRESS_DENIED");
    expect(document.body.textContent).not.toContain("external-url");
  });
});
