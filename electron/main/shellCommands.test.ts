/**
 * shellCommands の単体テスト（vitest node 環境 + electron モジュールモック）。
 * openExternal スキーム再検証 / fs・zoom・windowControl の envelope 化を検証する。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Envelope } from "../shared/ipcContract.js";
import { IPC } from "../shared/ipcContract.js";

// ── electron モック（sandbox 外の node 環境では実 electron は import 不可） ──

const handlers = new Map<
  string,
  (event: unknown, ...args: unknown[]) => unknown
>();

const openExternalMock = vi.fn(() => Promise.resolve());
const openPathMock = vi.fn(() => Promise.resolve(""));
const showOpenDialogMock = vi.fn();
const showSaveDialogMock = vi.fn();
const fromWebContentsMock = vi.fn();

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0-test" },
  dialog: {
    showOpenDialog: showOpenDialogMock,
    showSaveDialog: showSaveDialogMock,
  },
  shell: { openExternal: openExternalMock, openPath: openPathMock },
  ipcMain: {
    handle: (
      channel: string,
      fn: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: { fromWebContents: fromWebContentsMock },
}));

const { buildShellCommandHandlers, registerShellBridgeHandlers } =
  await import("./shellCommands.js");
const { WEB_EDITOR_HANDOFF_MAX_FILE_BYTES } =
  await import("./shellCommands.js");

async function invokeBridge(
  channel: string,
  event: unknown,
  ...args: unknown[]
): Promise<Envelope> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return (await handler(event, ...args)) as Envelope;
}

beforeAll(() => {
  registerShellBridgeHandlers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tauri コマンド互換ハンドラ
// ─────────────────────────────────────────────────────────────────────────────

describe("export / logs（Phase 3 main-TS コマンド — commands/export.rs / logs.rs の写像）", () => {
  const filterArgs = {
    suggestedName: "out.txt",
    filterName: "Text",
    extensions: ["txt"],
  };

  it("export_save_text: 保存ダイアログ由来のパスへ書き込み、絶対パスを返す", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-export-"));
    try {
      const dest = path.join(dir, "out.txt");
      showSaveDialogMock.mockResolvedValueOnce({
        canceled: false,
        filePath: dest,
      });
      const h = buildShellCommandHandlers(null);
      await expect(
        h.export_save_text({ ...filterArgs, contents: "本文テキスト" }),
      ).resolves.toBe(dest);
      expect(readFileSync(dest, "utf8")).toBe("本文テキスト");
      // renderer からパスは渡っていない（PIO-2）— ダイアログ引数は名前+filter のみ
      const options = showSaveDialogMock.mock.calls[0][0] as {
        defaultPath: string;
        filters: unknown[];
      };
      expect(options.defaultPath).toBe("out.txt");
      expect(options.filters).toEqual([{ name: "Text", extensions: ["txt"] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("export_save_text: キャンセル時は null を返し何も書かない", async () => {
    showSaveDialogMock.mockResolvedValueOnce({ canceled: true });
    const h = buildShellCommandHandlers(null);
    await expect(
      h.export_save_text({ ...filterArgs, contents: "x" }),
    ).resolves.toBeNull();
  });

  it("export_save_bytes: base64 を復号して書き込む", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-export-"));
    try {
      const dest = path.join(dir, "out.bin");
      showSaveDialogMock.mockResolvedValueOnce({
        canceled: false,
        filePath: dest,
      });
      const h = buildShellCommandHandlers(null);
      await expect(
        h.export_save_bytes({ ...filterArgs, contentsBase64: "aGVsbG8=" }),
      ).resolves.toBe(dest);
      expect(readFileSync(dest, "utf8")).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("export_save_bytes: 不正 base64 はダイアログを開く前に拒否（Rust base64 crate と同挙動）", async () => {
    showSaveDialogMock.mockClear();
    const h = buildShellCommandHandlers(null);
    await expect(
      h.export_save_bytes({ ...filterArgs, contentsBase64: "%%%invalid%%%" }),
    ).rejects.toThrow("invalid base64 export payload");
    expect(showSaveDialogMock).not.toHaveBeenCalled();
  });

  it("open_log_dir: ログフォルダを作成してファイルマネージャで開く", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-logs-"));
    try {
      const logDir = path.join(dir, ".grimodex", "logs");
      openPathMock.mockResolvedValueOnce("");
      const h = buildShellCommandHandlers(null, logDir);
      await expect(h.open_log_dir({})).resolves.toBeNull();
      expect(existsSync(logDir)).toBe(true);
      expect(openPathMock).toHaveBeenCalledWith(logDir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("open_log_dir: openPath がエラー文字列を返したら reject", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-logs-"));
    try {
      openPathMock.mockResolvedValueOnce("no file manager");
      const h = buildShellCommandHandlers(
        null,
        path.join(dir, "logs"),
      );
      await expect(h.open_log_dir({})).rejects.toThrow(
        "ログフォルダを開けませんでした",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("semantic_reranker_shadow_record: 本文を受け付けずsafe JSONLだけを追記する", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-shadow-"));
    try {
      const h = buildShellCommandHandlers(null, dir);
      await expect(
        h.semantic_reranker_shadow_record({
          record: {
            schemaVersion: 1,
            status: "completed",
            runId: "run-1",
            generation: 1,
            requestId: "request-1",
            workspaceKey: "workspace-1",
            workspaceOpenRevision: 7,
            projectId: "project-1",
            language: "ja",
            localInferenceExpected: false,
            queryHash: "query-hash",
            candidateSetHash: "candidate-set-hash",
            modelId: "hotchpotch/japanese-reranker-xsmall-v2",
            modelRevision: "revision",
            manifestSha256: "manifest",
            candidateCount: 1,
            retrievalLatencyMs: 8,
            queueLatencyMs: 2,
            ipcRoundTripMs: 125,
            nativeLatencyMs: 120,
            endToEndLatencyMs: 135,
            modelLoadMs: 0,
            modelWasCold: false,
            comparison: {
              baselineSceneOrder: ["scene-a"],
              rerankedSceneOrder: ["scene-a"],
              baselineInjectedSceneIds: ["scene-a"],
              counterfactualInjectedSceneIds: ["scene-a"],
              baselineInjectedCandidateHashes: ["candidate-a"],
              counterfactualInjectedCandidateHashes: ["candidate-a"],
              injectedSetChanged: false,
              injectedOrderChanged: false,
            firstPresentedChanged: false,
              ranking: [
                {
                  candidateHash: "candidate-a",
                  sceneId: "scene-a",
                  denseRank: 1,
                  currentRank: 1,
                  rerankedRank: 1,
                  denseScore: 0.9,
                  rerankerScore: 2.1,
                  tokenization: {
                    queryTokensBefore: 50,
                    queryTokensAfter: 50,
                    candidateTokensBefore: 100,
                    candidateTokensAfter: 100,
                    queryTruncated: false,
                    candidateTruncated: false,
                    userMessageTokensKept: 20,
                    sceneTailTokensKept: 30,
                  },
                },
              ],
            },
          },
        }),
      ).resolves.toBeNull();

      const persisted = JSON.parse(
        readFileSync(path.join(dir, "semantic-reranker-shadow.jsonl"), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted.workspaceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(persisted.projectHash).toMatch(/^[a-f0-9]{64}$/);
      expect(persisted.requestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(persisted).not.toHaveProperty("workspaceKey");
      expect(persisted).not.toHaveProperty("projectId");
      expect(JSON.stringify(persisted)).not.toContain("workspace-1");
      expect(
        (
          persisted.comparison as {
            ranking: Array<{ denseRank: number }>;
          }
        ).ranking[0].denseRank,
      ).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("semantic_reranker_shadow_record: manuscript-like unknown fields are rejected and never written", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-shadow-"));
    try {
      const h = buildShellCommandHandlers(null, dir);
      await expect(
        h.semantic_reranker_shadow_record({
          record: {
            schemaVersion: 1,
            status: "failed",
            runId: "run-1",
            generation: 1,
            requestId: "request-1",
            workspaceKey: "workspace-1",
            workspaceOpenRevision: 7,
            projectId: "project-1",
            language: "ja",
            localInferenceExpected: false,
            manuscriptText: "保存してはいけない本文",
          },
        }),
      ).rejects.toThrow(/unknown field.*manuscriptText/);
      expect(
        existsSync(path.join(dir, "semantic-reranker-shadow.jsonl")),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ブリッジ native API
// ─────────────────────────────────────────────────────────────────────────────

describe("openExternal（scheme 再検証 = safeUrl.ts と二重防御）", () => {
  it("https は許可される", async () => {
    const env = await invokeBridge(
      IPC.openExternal,
      { sender: {} },
      "https://example.com/",
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(openExternalMock).toHaveBeenCalledWith("https://example.com/");
  });

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/plain,x"])(
    "%s は envelope エラーで拒否（shell.openExternal 不達）",
    async (url) => {
      openExternalMock.mockClear();
      const env = await invokeBridge(IPC.openExternal, { sender: {} }, url);
      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.error).toContain("blocked external URL");
      expect(openExternalMock).not.toHaveBeenCalled();
    },
  );
});

describe("fs ブリッジ（ダイアログ許可制スコープ — fsScope.ts）", () => {
  /** dialog.openFolder をモックで成功させてスコープを付与する。 */
  async function grantFolder(dir: string): Promise<void> {
    fromWebContentsMock.mockReturnValue(null);
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: [dir],
    });
    const picked = await invokeBridge(IPC.dialogOpenFolder, { sender: {} });
    expect(picked).toEqual({ ok: true, value: dir });
  }

  it("dialog.openFolder で選んだフォルダ配下は readTextFile / readDir が読める", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-fs-"));
    try {
      writeFileSync(path.join(dir, "a.txt"), "こんにちは", "utf8");
      await grantFolder(dir);

      const text = await invokeBridge(
        IPC.fsReadTextFile,
        { sender: {} },
        path.join(dir, "a.txt"),
      );
      expect(text).toEqual({ ok: true, value: "こんにちは" });

      const listing = await invokeBridge(IPC.fsReadDir, { sender: {} }, dir);
      expect(listing).toEqual({
        ok: true,
        value: [
          { name: "a.txt", isDirectory: false, isFile: true, isSymlink: false },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dialog.openFile で選んだ単一ファイルは readTextFile が読める", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-fs-"));
    try {
      writeFileSync(path.join(dir, "pick.md"), "# picked", "utf8");
      fromWebContentsMock.mockReturnValue(null);
      showOpenDialogMock.mockResolvedValueOnce({
        canceled: false,
        filePaths: [path.join(dir, "pick.md")],
      });
      const picked = await invokeBridge(
        IPC.dialogOpenFile,
        { sender: {} },
        {
          name: "Markdown",
          extensions: ["md"],
        },
      );
      expect(picked).toEqual({ ok: true, value: path.join(dir, "pick.md") });

      const text = await invokeBridge(
        IPC.fsReadTextFile,
        { sender: {} },
        path.join(dir, "pick.md"),
      );
      expect(text).toEqual({ ok: true, value: "# picked" });

      // file grant は readDir を許可しない
      const listing = await invokeBridge(IPC.fsReadDir, { sender: {} }, dir);
      expect(listing.ok).toBe(false);
      if (!listing.ok) expect(listing.error).toContain("FS_SCOPE_DENIED:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Web Editor handoff は専用ピッカで上限確認後に本文を返す", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-handoff-"));
    try {
      const file = path.join(dir, "draft.grimodex-handoff");
      writeFileSync(file, '{"schemaVersion":"test"}', "utf8");
      fromWebContentsMock.mockReturnValue(null);
      showOpenDialogMock.mockResolvedValueOnce({
        canceled: false,
        filePaths: [file],
      });

      const picked = await invokeBridge(IPC.dialogOpenWebEditorHandoff, {
        sender: {},
      });

      expect(picked).toEqual({
        ok: true,
        value: {
          name: "draft.grimodex-handoff",
          content: '{"schemaVersion":"test"}',
        },
      });
      expect(showOpenDialogMock).toHaveBeenCalledWith({
        properties: ["openFile"],
        filters: [
          {
            name: "Grimodex Web Editor handoff",
            extensions: ["grimodex-handoff"],
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Web Editor handoff はmainで上限超過を拒否しrendererへ本文を返さない", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-handoff-"));
    try {
      const file = path.join(dir, "oversize.grimodex-handoff");
      writeFileSync(file, "{}", "utf8");
      truncateSync(file, WEB_EDITOR_HANDOFF_MAX_FILE_BYTES + 1);
      fromWebContentsMock.mockReturnValue(null);
      showOpenDialogMock.mockResolvedValueOnce({
        canceled: false,
        filePaths: [file],
      });

      const picked = await invokeBridge(IPC.dialogOpenWebEditorHandoff, {
        sender: {},
      });

      expect(picked.ok).toBe(false);
      if (!picked.ok) {
        expect(picked.error).toContain("WEB_EDITOR_HANDOFF_FILE_TOO_LARGE");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ダイアログで許可していないパスは FS_SCOPE_DENIED の envelope エラー", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-fs-deny-"));
    try {
      writeFileSync(path.join(dir, "secret.txt"), "ひみつ", "utf8");
      const env = await invokeBridge(
        IPC.fsReadTextFile,
        { sender: {} },
        path.join(dir, "secret.txt"),
      );
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error).toContain("FS_SCOPE_DENIED:");
        expect(env.error.startsWith("Error:")).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("スコープ内の不存在ファイルは従来どおり ENOENT の envelope エラー", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grim-shell-fs-"));
    try {
      await grantFolder(dir);
      const env = await invokeBridge(
        IPC.fsReadTextFile,
        { sender: {} },
        path.join(dir, "no-such-file.txt"),
      );
      expect(env.ok).toBe(false);
      if (!env.ok) {
        expect(env.error).toContain("ENOENT");
        expect(env.error.startsWith("Error:")).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("windowControl", () => {
  it("isMaximized は送信元窓の状態を返す", async () => {
    fromWebContentsMock.mockReturnValue({ isMaximized: () => true });
    const env = await invokeBridge(
      IPC.windowControl,
      { sender: {} },
      "isMaximized",
    );
    expect(env).toEqual({ ok: true, value: true });
  });

  it("toggleMaximize は最大化状態で unmaximize する", async () => {
    const unmaximize = vi.fn();
    const maximize = vi.fn();
    fromWebContentsMock.mockReturnValue({
      isMaximized: () => true,
      maximize,
      unmaximize,
    });
    const env = await invokeBridge(
      IPC.windowControl,
      { sender: {} },
      "toggleMaximize",
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(unmaximize).toHaveBeenCalled();
    expect(maximize).not.toHaveBeenCalled();
  });

  it("toggleFullscreen は送信元窓を切り替え、確定した状態を返す", async () => {
    const setFullScreen = vi.fn();
    fromWebContentsMock.mockReturnValue({
      isFullScreen: () => false,
      setFullScreen,
    });

    const env = await invokeBridge(
      IPC.windowControl,
      { sender: {} },
      "toggleFullscreen",
    );

    expect(env).toEqual({ ok: true, value: true });
    expect(setFullScreen).toHaveBeenCalledWith(true);
  });

  it("isFullscreen は送信元窓の状態を返す", async () => {
    fromWebContentsMock.mockReturnValue({ isFullScreen: () => true });

    const env = await invokeBridge(
      IPC.windowControl,
      { sender: {} },
      "isFullscreen",
    );

    expect(env).toEqual({ ok: true, value: true });
  });

  it("窓が見つからない webContents は envelope エラー", async () => {
    fromWebContentsMock.mockReturnValue(null);
    const env = await invokeBridge(
      IPC.windowControl,
      { sender: {} },
      "minimize",
    );
    expect(env.ok).toBe(false);
  });

  it("未知の op は envelope エラー", async () => {
    fromWebContentsMock.mockReturnValue({ isMaximized: () => false });
    const env = await invokeBridge(
      IPC.windowControl,
      { sender: {} },
      "destroy",
    );
    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.error).toContain("unknown window control op");
  });
});

describe("setZoomFactor / getVersion / panelWindow スタブ", () => {
  it("zoom は main 側でクランプして sender に適用する", async () => {
    const setZoomFactor = vi.fn();
    const env = await invokeBridge(
      IPC.setZoomFactor,
      { sender: { setZoomFactor } },
      100,
    );
    expect(env).toEqual({ ok: true, value: null });
    expect(setZoomFactor).toHaveBeenCalledWith(4);
  });

  it("getVersion は app.getVersion() を返す", async () => {
    const env = await invokeBridge(IPC.getVersion, { sender: {} });
    expect(env).toEqual({ ok: true, value: "1.0.0-test" });
  });

  it("panelWindow は S7 まで IPC_UNIMPLEMENTED スタブ", async () => {
    const open = await invokeBridge(
      IPC.panelOpen,
      { sender: {} },
      "panel-codex",
      {},
    );
    expect(open).toEqual({
      ok: false,
      error: "IPC_UNIMPLEMENTED: panelWindow.open",
    });
    const focus = await invokeBridge(
      IPC.panelFocus,
      { sender: {} },
      "panel-codex",
    );
    expect(focus).toEqual({
      ok: false,
      error: "IPC_UNIMPLEMENTED: panelWindow.focusByLabel",
    });
  });
});
