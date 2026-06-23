// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OpenaiCompatibleEndpointsManager } from "./OpenaiCompatibleEndpointsManager";
import type { OpenaiCompatibleEndpoint } from "@/features/chat/types";

// i18n は key をそのまま返すモック（メッセージ文言ではなく挙動を検証する）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const { hasApiKey, deleteApiKey, saveApiKey } = vi.hoisted(() => ({
  hasApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  saveApiKey: vi.fn(),
}));

vi.mock("@/features/chat/api", () => ({
  hasApiKey: (...a: unknown[]) => hasApiKey(...a),
  deleteApiKey: (...a: unknown[]) => deleteApiKey(...a),
  saveApiKey: (...a: unknown[]) => saveApiKey(...a),
  testAiConnection: vi.fn(),
  listAiModels: vi.fn().mockResolvedValue([]),
}));

const EP: OpenaiCompatibleEndpoint = {
  id: "default",
  label: "",
  baseUrl: "http://localhost:1234/v1",
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
