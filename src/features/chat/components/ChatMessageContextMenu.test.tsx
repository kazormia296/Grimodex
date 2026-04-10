// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatMessageContextMenu } from "./ChatMessageContextMenu";

const defaultProps = {
  messageId: "msg-1",
  messageRole: "assistant" as const,
  messageContent: "これはアシスタントのメッセージです。",
  selectedText: null,
  x: 100,
  y: 200,
  onClose: vi.fn(),
  onInsert: vi.fn(),
  onExtractCodexQuick: vi.fn(),
  onExtractCodexDetailed: vi.fn(),
  onSaveSnippetQuick: vi.fn(),
  onSaveSnippetDetailed: vi.fn(),
  onCopy: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onRegenerate: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ChatMessageContextMenu", () => {
  describe("アシスタントメッセージ（選択なし）", () => {
    it("全8項目が表示される", () => {
      render(<ChatMessageContextMenu {...defaultProps} />);
      expect(screen.getByTestId("ctx-insert")).toBeInTheDocument();
      expect(screen.getByTestId("ctx-extract-codex-quick")).toBeInTheDocument();
      expect(
        screen.getByTestId("ctx-extract-codex-detailed"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("ctx-save-snippet-quick")).toBeInTheDocument();
      expect(
        screen.getByTestId("ctx-save-snippet-detailed"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("ctx-copy")).toBeInTheDocument();
      expect(screen.getByTestId("ctx-regenerate")).toBeInTheDocument();
      expect(screen.getByTestId("ctx-delete")).toBeInTheDocument();
    });

    it("「編集」は表示されない", () => {
      render(<ChatMessageContextMenu {...defaultProps} />);
      expect(screen.queryByTestId("ctx-edit")).not.toBeInTheDocument();
    });

    it("エディタに挿入ボタンがonInsertを呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...defaultProps} />);
      await user.click(screen.getByTestId("ctx-insert"));
      expect(defaultProps.onInsert).toHaveBeenCalledWith(
        defaultProps.messageContent,
        defaultProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("Codex即時抽出ボタンがonExtractCodexQuickを呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...defaultProps} />);
      await user.click(screen.getByTestId("ctx-extract-codex-quick"));
      expect(defaultProps.onExtractCodexQuick).toHaveBeenCalledWith(
        defaultProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("Codex詳細抽出ボタンがonExtractCodexDetailedを呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...defaultProps} />);
      await user.click(screen.getByTestId("ctx-extract-codex-detailed"));
      expect(defaultProps.onExtractCodexDetailed).toHaveBeenCalledWith(
        defaultProps.messageId,
        null,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("Snippet即時保存ボタンがonSaveSnippetQuickを呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...defaultProps} />);
      await user.click(screen.getByTestId("ctx-save-snippet-quick"));
      expect(defaultProps.onSaveSnippetQuick).toHaveBeenCalledWith(
        defaultProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("Snippet詳細保存ボタンがonSaveSnippetDetailedを呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...defaultProps} />);
      await user.click(screen.getByTestId("ctx-save-snippet-detailed"));
      expect(defaultProps.onSaveSnippetDetailed).toHaveBeenCalledWith(
        defaultProps.messageId,
        null,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("コピーボタンがonCopyをmessageContentで呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...defaultProps} />);
      await user.click(screen.getByTestId("ctx-copy"));
      expect(defaultProps.onCopy).toHaveBeenCalledWith(
        defaultProps.messageContent,
        defaultProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("再生成ボタンがonRegenerateを呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...defaultProps} />);
      await user.click(screen.getByTestId("ctx-regenerate"));
      expect(defaultProps.onRegenerate).toHaveBeenCalledWith(
        defaultProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("削除ボタンがonDeleteを呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...defaultProps} />);
      await user.click(screen.getByTestId("ctx-delete"));
      expect(defaultProps.onDelete).toHaveBeenCalledWith(
        defaultProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  describe("ユーザーメッセージ（選択なし）", () => {
    const userProps = {
      ...defaultProps,
      messageRole: "user" as const,
      messageContent: "これはユーザーのメッセージです。",
    };

    it("3項目（編集・コピー・削除）が表示される", () => {
      render(<ChatMessageContextMenu {...userProps} />);
      expect(screen.getByTestId("ctx-edit")).toBeInTheDocument();
      expect(screen.getByTestId("ctx-copy")).toBeInTheDocument();
      expect(screen.getByTestId("ctx-delete")).toBeInTheDocument();
    });

    it("「再生成」は表示されない", () => {
      render(<ChatMessageContextMenu {...userProps} />);
      expect(screen.queryByTestId("ctx-regenerate")).not.toBeInTheDocument();
    });

    it("「エディタに挿入」は表示されない", () => {
      render(<ChatMessageContextMenu {...userProps} />);
      expect(screen.queryByTestId("ctx-insert")).not.toBeInTheDocument();
    });

    it("編集ボタンがonEditを呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...userProps} />);
      await user.click(screen.getByTestId("ctx-edit"));
      expect(defaultProps.onEdit).toHaveBeenCalledWith(userProps.messageId);
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("コピーボタンがonCopyをmessageContentで呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...userProps} />);
      await user.click(screen.getByTestId("ctx-copy"));
      expect(defaultProps.onCopy).toHaveBeenCalledWith(
        userProps.messageContent,
        userProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  describe("テキスト選択モード", () => {
    const selectedProps = {
      ...defaultProps,
      selectedText: "選択されたテキスト",
    };

    it("4項目が表示される", () => {
      render(<ChatMessageContextMenu {...selectedProps} />);
      expect(screen.getByTestId("ctx-insert-selection")).toBeInTheDocument();
      expect(
        screen.getByTestId("ctx-extract-codex-selection"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("ctx-save-snippet-selection"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("ctx-copy")).toBeInTheDocument();
    });

    it("アシスタント専用項目は表示されない", () => {
      render(<ChatMessageContextMenu {...selectedProps} />);
      expect(screen.queryByTestId("ctx-insert")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("ctx-extract-codex-quick"),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("ctx-regenerate")).not.toBeInTheDocument();
    });

    it("選択テキストをエディタに挿入ボタンがonInsertをselectedTextで呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...selectedProps} />);
      await user.click(screen.getByTestId("ctx-insert-selection"));
      expect(defaultProps.onInsert).toHaveBeenCalledWith(
        selectedProps.selectedText,
        selectedProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("Codexに抽出ボタンがonExtractCodexDetailedをselectedTextで呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...selectedProps} />);
      await user.click(screen.getByTestId("ctx-extract-codex-selection"));
      expect(defaultProps.onExtractCodexDetailed).toHaveBeenCalledWith(
        selectedProps.messageId,
        selectedProps.selectedText,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("Snippetとして保存ボタンがonSaveSnippetDetailedをselectedTextで呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...selectedProps} />);
      await user.click(screen.getByTestId("ctx-save-snippet-selection"));
      expect(defaultProps.onSaveSnippetDetailed).toHaveBeenCalledWith(
        selectedProps.messageId,
        selectedProps.selectedText,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("コピーボタンがonCopyをselectedTextで呼ぶ", async () => {
      const user = userEvent.setup();
      render(<ChatMessageContextMenu {...selectedProps} />);
      await user.click(screen.getByTestId("ctx-copy"));
      expect(defaultProps.onCopy).toHaveBeenCalledWith(
        selectedProps.selectedText,
        selectedProps.messageId,
      );
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  describe("閉じる動作", () => {
    it("EscapeキーでonCloseが呼ばれる", () => {
      render(<ChatMessageContextMenu {...defaultProps} />);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it("メニュー外のpointerdownでonCloseが呼ばれる", () => {
      render(
        <div>
          <ChatMessageContextMenu {...defaultProps} />
          <button data-testid="outside">外部要素</button>
        </div>,
      );
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });
});
