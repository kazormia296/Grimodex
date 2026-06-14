# チャットプロンプトビルダー統合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** チャットの「プレビュー / 右クリックコピー / 実送信」が「これから送るメッセージ」を共通 seed にして同一プロンプトを出すよう統合し、関連シーン欠落(①)・seed 不一致(②)・入力非表示(③)・copy の eco 無視(④)を解消する。

**Architecture:** scene スコープの outgoing プロンプト組み立てを共通ヘルパ `buildOutgoingScenePrompt` に集約し、preview と copy を両方そこへ寄せる。入力中テキストは ChatInput がモジュールレベル DI(`_inputDraftProvider`)に登録し、`buildPreviewPrompt` が開いた瞬間に読む。send(`sendMessage`)は構造が異なるため畳み込まず、同一 `buildSceneContextPrompt` 呼び出しを正準として維持する。

**Tech Stack:** TypeScript / Zustand(chatStore)/ React 19 関数コンポーネント / Vitest(happy-dom)/ i18next。

設計書: `docs/superpowers/specs/2026-06-15-chat-prompt-builder-unification-design.md`

---

## ファイル構成

- **Modify** `src/features/chat/chatStore.ts`
  - 新規モジュールレベル関数 `buildOutgoingScenePrompt`(`buildSceneContextPrompt` の近く / 既存の `let _resolveUserQuestion` 等の DI 群に `_inputDraftProvider` を追加)
  - `buildPromptForCopy`(現 2609-2728)scene 分岐をヘルパ経由に
  - `buildPreviewPrompt`(現 4300-4364)をヘルパ + DI seed + `userMessage` 返却に
  - `ChatState` interface: `buildPreviewPrompt` 戻り型に `userMessage` 追加、`registerInputDraftProvider` 追加
  - `semanticRecallSeedMessage` JSDoc(1567-1570)是正
- **Modify** `src/features/chat/components/ChatInput.tsx`(現 108-)— mount 時に `registerInputDraftProvider` 登録 / unmount 解除
- **Modify** `src/features/chat/components/PromptPreviewModal.tsx` — `userMessage?: string` prop + 送信メッセージセクション
- **Modify** `src/features/chat/components/ContextBar.tsx` — `previewData` 型に `userMessage` 追加、モーダルへ受け渡し
- **Modify** `src/locales/ja.json` / `src/locales/en.json` — `chat.context.outgoingMessage` 追加
- **Test** `src/features/chat/chatStore.test.ts`, `src/features/chat/components/PromptPreviewModal.test.tsx`

---

## Task 1: 共通ヘルパ `buildOutgoingScenePrompt` を新設し copy を寄せる(①④)

**Files:**
- Modify: `src/features/chat/chatStore.ts`(ヘルパ新設 + `buildPromptForCopy` scene 分岐 2631-2661)
- Test: `src/features/chat/chatStore.test.ts`(`describe("context injection")` 内 buildPromptForCopy 群, 975- の末尾に追加)

- [ ] **Step 1: 失敗するテストを書く**

`src/features/chat/chatStore.test.ts` の `it("buildPromptForCopy with mentions reverts ...")` ブロックの直後(同じ describe 内)に追加:

```ts
it("buildPromptForCopy scene スコープ: 入力を seed に related_scenes を含め、eco で本文を空にする", async () => {
  const { getNode } = await import("@/features/tree/api");
  const { loadScene } = await import("@/features/tree/api");
  const { semanticSearch } = await import("@/features/semantic-search/api");
  const mockSearch = vi.mocked(semanticSearch);
  vi.mocked(getNode).mockResolvedValue({
    id: "scene-1",
    title: "テストシーン",
    synopsis: "要約",
  } as never);
  vi.mocked(loadScene).mockResolvedValue("これは長いシーン本文");
  mockSearch.mockResolvedValueOnce([
    {
      sceneId: "other-scene",
      sceneTitle: "過去シーン",
      chunkText: "関連する過去の抜粋",
      charStart: 0,
      charEnd: 10,
      score: 0.9,
      dialogueRatio: 0,
    },
  ] as never);
  mockBuildSystemPrompt.mockReturnValue({
    prompt: "COPY SYS",
    totalTokens: 1,
    layers: [],
  });

  useChatStore.setState({
    activeSceneId: "scene-1",
    activeProjectId: "proj-1",
    activeSessionId: null,
    chatScope: "scene",
    scopeAnchorId: null,
    inputPinnedEntryIds: [],
    includeBodies: false, // eco
    messages: [],
  });

  const result = await useChatStore
    .getState()
    .buildPromptForCopy("今書いてる入力");

  // ① 入力を seed に意味検索が走り related_scenes が buildSystemPrompt へ
  expect(mockSearch).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "proj-1",
      query: expect.stringContaining("今書いてる入力"),
    }),
  );
  expect(mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.semanticRecall).toBeDefined();
  // ④ eco: 本文ブランク
  expect(mockBuildSystemPrompt.mock.calls.at(-1)?.[0]?.scene.content).toBe("");
  // system + 末尾の入力行
  expect(result).toContain("[system]\nCOPY SYS");
  expect(result).toContain("[user]\n今書いてる入力");
});
```

> `loadScene` のモック var 名はファイル先頭で既に `mockLoadScene` として定義済み(1978-1979 で使用)。上記は動的 import で取得する形にしているが、ファイル先頭で `vi.mocked(loadScene)` が使えるなら `mockLoadScene.mockResolvedValue(...)` でも可。既存テスト(1973-1979)の流儀に合わせること。

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm test --run src/features/chat/chatStore.test.ts -t "scene スコープ: 入力を seed"`
Expected: FAIL — 現状 copy は `semanticRecallSeedMessage` を渡さず eco もブランクしないため `mockSearch` 未呼び出し / `scene.content` が非空。

- [ ] **Step 3: ヘルパを実装**

`src/features/chat/chatStore.ts` の `buildSceneContextPrompt` 関数定義(1552 付近)の**直前**にモジュールレベル関数を追加:

```ts
/**
 * preview / copy 共通の scene スコープ "outgoing プロンプト" ビルダー。
 * 「これから送るメッセージ (inputText)」を semantic recall の seed と会話末尾の
 * outgoing user message の両方に反映し、send (sendMessage) と同一の
 * buildSceneContextPrompt 呼び出しに揃える。eco (includeBodies=false) の本文
 * ブランクもここで一元化する。
 */
async function buildOutgoingScenePrompt(
  get: () => ChatState,
  effectiveSceneId: string,
  opts: { inputText: string; mentionedSceneIds?: string[] },
): Promise<{
  prompt: string;
  layers: LayerBreakdown[];
  totalTokens: number;
} | null> {
  await ensureTokenizer();
  const {
    activeProjectId,
    activeSessionId,
    inputPinnedEntryIds,
    excludedAutoEntryIds,
    agentMode,
    includeBodies,
    messages,
  } = get();

  const [sceneCtx, projectCtx] = await Promise.all([
    fetchSceneContext(effectiveSceneId),
    fetchProjectContext(activeProjectId),
  ]);
  if (!sceneCtx) return null;

  const input = opts.inputText.trim();

  // RAG seed: 今送る入力 → 無ければ直近 user 発話 → 無ければ本文末尾。
  // 本文末尾は eco ブランク前の本文から取る(seed はクエリであって注入ではない)。
  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === "user" && !m.isSummarized)?.content;
  const seed =
    input ||
    lastUserMessage?.trim() ||
    sceneCtx.content.slice(-SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS);

  // eco モード: send / refreshContextLayers と揃えて本文を空にする。
  if (!includeBodies) {
    sceneCtx.content = "";
  }

  // 会話履歴 + これから送るメッセージ(send の messagesForCtx と同形)。
  const conversationMessages: ChatMessage[] = [
    ...messages.filter((m) => !m.isSummarized),
    ...(input
      ? [
          {
            id: "outgoing",
            sessionId: activeSessionId ?? "",
            role: "user",
            content: opts.inputText,
            createdAt: new Date().toISOString(),
          } as ChatMessage,
        ]
      : []),
  ];

  const { prompt, layers, totalTokens } = await buildSceneContextPrompt({
    sceneCtx,
    projectCtx,
    activeSessionId,
    effectiveSceneId,
    inputPinnedEntryIds,
    conversationMessages,
    agentMode,
    mentionedSceneIds: opts.mentionedSceneIds,
    excludedAutoEntryIds,
    semanticRecallSeedMessage: seed,
  });
  return { prompt, layers, totalTokens };
}
```

次に `buildPromptForCopy` の scene 分岐を置換。現在の 2631-2661(`if (effectiveSceneId) { ... contextLoaded = true; } }` の Promise.all〜buildSceneContextPrompt ブロック)を以下に差し替え:

```ts
      if (effectiveSceneId) {
        const built = await buildOutgoingScenePrompt(get, effectiveSceneId, {
          inputText: userInput,
          mentionedSceneIds: options?.mentionedSceneIds,
        });
        if (built) {
          parts.push(`[system]\n${built.prompt}`);
          contextLoaded = true;
        }
      } else if (
```

> 置換範囲は「`if (effectiveSceneId) {` から、その直後の `} else if (` の手前まで」。`else if` 以降(非 scene 分岐 2662-2696)・末尾の履歴/[user] 連結(2718-2725)・mention cleanup(2701-2709)はそのまま残す。`fetchSceneContext` / `fetchProjectContext` / `conversationMessages` を直接組んでいた旧コードはヘルパに移ったので消える。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm test --run src/features/chat/chatStore.test.ts -t "scene スコープ: 入力を seed"`
Expected: PASS

- [ ] **Step 5: 既存 copy テストの非回帰を確認**

Run: `pnpm test --run src/features/chat/chatStore.test.ts -t buildPromptForCopy`
Expected: PASS(非 scene 4 ケース + 新規 scene ケース)

- [ ] **Step 6: コミット**

```bash
git add src/features/chat/chatStore.ts src/features/chat/chatStore.test.ts
git commit -m "$(cat <<'EOF'
refactor(chat): 共通 buildOutgoingScenePrompt を新設し copy を統合

右クリックコピーが related_scenes を欠き eco モードを無視していた問題を
共通ヘルパ経由に寄せて修正(①④)。send と同一の seed/会話/eco 規則に揃える。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 入力ドラフト DI + buildPreviewPrompt 改修(②③ data 部分)

**Files:**
- Modify: `src/features/chat/chatStore.ts`(DI 変数 1429-1440 群 / `ChatState` interface 425-429・新規アクション / `buildPreviewPrompt` 4300-4364)
- Test: `src/features/chat/chatStore.test.ts`(`describe("buildPreviewPrompt")` 2009- / beforeEach にクリーンアップ追加)

- [ ] **Step 1: 失敗するテストを書く**

まず `describe("useChatStore")` の `beforeEach`(255 付近)に DI リーク防止のクリーンアップを追加(モジュールレベル `_inputDraftProvider` はテスト間で残るため):

```ts
    // プロンプトプレビューの入力ドラフト DI をテスト間でリセット
    useChatStore.getState().registerInputDraftProvider(null);
```

次に `describe("buildPreviewPrompt")`(2009)内、既存の「非 scene スコープ」テストの後に追加:

```ts
    it("scene スコープ: 入力ドラフトを seed に使い userMessage を返す", async () => {
      const { getNode } = await import("@/features/tree/api");
      const { semanticSearch } = await import("@/features/semantic-search/api");
      const mockSearch = vi.mocked(semanticSearch);
      vi.mocked(getNode).mockResolvedValue({
        id: "scene-1",
        title: "テストシーン",
      } as never);
      mockSearch.mockResolvedValueOnce([] as never);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "P",
        totalTokens: 0,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
        includeBodies: true,
        messages: [
          {
            id: "u1",
            sessionId: "",
            role: "user",
            content: "履歴の発話",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      });

      useChatStore.getState().registerInputDraftProvider(() => ({
        markdown: "入力中のテキスト",
        mentionedSceneIds: [],
      }));

      const result = await useChatStore.getState().buildPreviewPrompt();

      // seed は履歴ではなく入力ドラフト(②)
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("入力中のテキスト"),
        }),
      );
      // 入力メッセージをモーダルへ返す(③)
      expect(result.userMessage).toBe("入力中のテキスト");
    });

    it("不変条件: 同一入力で preview の prompt と copy の [system] が一致する", async () => {
      const { getNode } = await import("@/features/tree/api");
      const { semanticSearch } = await import("@/features/semantic-search/api");
      vi.mocked(getNode).mockResolvedValue({
        id: "scene-1",
        title: "テストシーン",
      } as never);
      vi.mocked(semanticSearch).mockResolvedValue([] as never);
      mockBuildSystemPrompt.mockReturnValue({
        prompt: "UNIFIED SYS",
        totalTokens: 3,
        layers: [],
      });

      useChatStore.setState({
        activeSceneId: "scene-1",
        activeProjectId: "proj-1",
        activeSessionId: null,
        chatScope: "scene",
        scopeAnchorId: null,
        inputPinnedEntryIds: [],
        includeBodies: true,
        messages: [],
      });
      useChatStore.getState().registerInputDraftProvider(() => ({
        markdown: "共通入力",
        mentionedSceneIds: [],
      }));

      const preview = await useChatStore.getState().buildPreviewPrompt();
      const copy = await useChatStore.getState().buildPromptForCopy("共通入力");

      // 両経路とも buildOutgoingScenePrompt を通り同一 system を出す
      expect(preview.prompt).toBe("UNIFIED SYS");
      expect(copy).toContain(`[system]\n${preview.prompt}`);
    });
```

> この不変条件テストが将来の再分岐(片方だけ別実装に戻る)を gate する(spec §6)。

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm test --run src/features/chat/chatStore.test.ts -t "入力ドラフトを seed"`
Expected: FAIL — `registerInputDraftProvider` 未定義(型エラー / ランタイム TypeError)。

- [ ] **Step 3: DI 変数 + アクション + 型を実装**

`chatStore.ts` のモジュールレベル DI 群(`let _agentAborted = false;` の直後, 1440 付近)に追加:

```ts
// プロンプトプレビューの seed / 表示用に、ChatInput の入力中テキストを on-demand
// で取得する DI。打鍵毎にストアへ書かず、プレビューを開いた瞬間だけ読む。
// ChatInput が mount 時に登録し unmount で null 解除する。
let _inputDraftProvider:
  | (() => { markdown: string; mentionedSceneIds: string[] })
  | null = null;
```

`ChatState` interface の `buildPreviewPrompt` 戻り型(425-429)に `userMessage` を追加:

```ts
  buildPreviewPrompt: () => Promise<{
    prompt: string;
    layers: LayerBreakdown[];
    totalTokens: number;
    /** プレビューに描画する「これから送る入力メッセージ」。空文字なら非表示。 */
    userMessage: string;
  }>;
```

同 interface の `buildPromptForCopy` 宣言(563-566)の直後にアクション宣言を追加:

```ts
  /** ChatInput の入力中テキスト getter を登録 / 解除(null で解除)。
   * buildPreviewPrompt が seed と表示に使う。 */
  registerInputDraftProvider: (
    provider:
      | (() => { markdown: string; mentionedSceneIds: string[] })
      | null,
  ) => void;
```

store 実装(`create<ChatState>()((set, get) => ({ ... }))` 内)に、`setAgentMode`(4366 付近)の隣へアクション実装を追加:

```ts
  registerInputDraftProvider: (provider) => {
    _inputDraftProvider = provider;
  },
```

- [ ] **Step 4: buildPreviewPrompt をヘルパ + DI seed + userMessage に置換**

`buildPreviewPrompt`(4300-4364)の本体全体を以下に差し替え:

```ts
  buildPreviewPrompt: async () => {
    const { activeSceneId, chatScope, lastSystemPrompt, contextLayers, contextTokenCount } =
      get();
    const draft = _inputDraftProvider?.() ?? {
      markdown: "",
      mentionedSceneIds: [],
    };
    // ライブ値フォールバック(RAG 非対象スコープ / 取得失敗時)。
    const live = {
      prompt: lastSystemPrompt,
      layers: contextLayers,
      totalTokens: contextTokenCount,
      userMessage: draft.markdown,
    };
    // semantic recall は scene スコープ限定。それ以外はライブ値が実送信と一致。
    const effectiveSceneId = chatScope === "scene" ? activeSceneId : null;
    if (!effectiveSceneId) return live;

    try {
      const built = await buildOutgoingScenePrompt(get, effectiveSceneId, {
        inputText: draft.markdown,
        mentionedSceneIds: draft.mentionedSceneIds,
      });
      if (!built) return live;
      return {
        prompt: built.prompt,
        layers: built.layers,
        totalTokens: built.totalTokens,
        userMessage: draft.markdown,
      };
    } catch {
      return live;
    }
  },
```

> 旧 buildPreviewPrompt が持っていた `ensureTokenizer` / `fetchSceneContext` / seed 計算 / eco ブランク / `buildSceneContextPrompt` 呼び出しは全て `buildOutgoingScenePrompt` に移譲済み。

- [ ] **Step 5: テストが通ることを確認**

Run: `pnpm test --run src/features/chat/chatStore.test.ts -t buildPreviewPrompt`
Expected: PASS(既存「非 scene」「直近ユーザー発話 seed」+ 新規「入力ドラフト seed」)。

> 既存「scene スコープ: 意味検索を seed 付きで...」テスト(2010)は provider 未登録のため seed が直近ユーザー発話「次の展開を相談したい」に縮退し、引き続き PASS する。戻り型に `userMessage` が増えたが既存テストは `result.prompt` のみ参照のため非回帰。

- [ ] **Step 6: コミット**

```bash
git add src/features/chat/chatStore.ts src/features/chat/chatStore.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): プレビューを入力中テキスト seed に統合し入力行を返す

入力ドラフト DI (_inputDraftProvider / registerInputDraftProvider) を追加し、
buildPreviewPrompt が「これから送る入力」を RAG seed に使い userMessage を返す
よう改修(②③)。scene 経路は buildOutgoingScenePrompt に集約。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: ChatInput が入力ドラフトプロバイダを登録

**Files:**
- Modify: `src/features/chat/components/ChatInput.tsx`(`collectMentionedSceneIds` 432-442 の後 / `editorRef` 公開 effect 226-229 の近く)

- [ ] **Step 1: プロバイダ登録の実装**

`ChatInput` 本体で store アクションを取得。既存の `buildPromptForCopy` セレクタ(121)の直後に追加:

```ts
  const registerInputDraftProvider = useChatStore(
    (s) => s.registerInputDraftProvider,
  );
```

`collectMentionedSceneIds`(432-442)の定義より後ろ(同 useCallback 群の近く)に、現在の入力中 markdown を返すヘルパと登録 effect を追加:

```ts
  // プレビュー(ContextBar)が seed / 表示に使う入力中テキストを on-demand 提供する。
  useEffect(() => {
    registerInputDraftProvider(() => {
      if (!editor) return { markdown: "", mentionedSceneIds: [] };
      const markdownStorage = editor.storage as unknown as Record<
        string,
        { getMarkdown?: () => string } | undefined
      >;
      const text = editor.getText().trim();
      const markdown = markdownStorage.markdown?.getMarkdown?.() ?? text;
      return {
        markdown,
        mentionedSceneIds: collectMentionedSceneIds() ?? [],
      };
    });
    return () => registerInputDraftProvider(null);
  }, [editor, registerInputDraftProvider, collectMentionedSceneIds]);
```

> `getMarkdown` の取得は `handleSendContextMenu`(466-472)/`handleSendClick`(448-452)と同じ流儀。`collectMentionedSceneIds` は `undefined` を返し得るので `?? []` で正規化。

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし。

- [ ] **Step 3: 関連コンポーネントテストの非回帰**

Run: `pnpm test --run src/features/chat/components/ContextBar.test.tsx src/features/chat/components/ContextBar.browser.test.tsx`
Expected: PASS(ContextBar は `useChatStore` を汎用モック `vi.fn(() => "")` しており、`registerInputDraftProvider` を購読しないため影響なし)。

- [ ] **Step 4: コミット**

```bash
git add src/features/chat/components/ChatInput.tsx
git commit -m "$(cat <<'EOF'
feat(chat): ChatInput が入力ドラフトをプレビュー DI へ登録

mount 時に現在の入力 markdown + @mention を返す provider を登録し、
unmount で解除。プレビューが実送信と同じ入力を seed に使えるようにする。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: PromptPreviewModal に送信メッセージ行を描画(③ 表示)+ ContextBar 配線 + i18n

**Files:**
- Modify: `src/features/chat/components/PromptPreviewModal.tsx`
- Modify: `src/features/chat/components/ContextBar.tsx`(previewData 型 166-170 / モーダル描画 910-920)
- Modify: `src/locales/ja.json`, `src/locales/en.json`
- Test: `src/features/chat/components/PromptPreviewModal.test.tsx`

- [ ] **Step 1: 失敗するテストを書く**

`src/features/chat/components/PromptPreviewModal.test.tsx` の `describe("PromptPreviewModal")` 内に追加:

```ts
  it("userMessage を渡すと送信メッセージを描画する", () => {
    render(
      <PromptPreviewModal
        systemPrompt="SYS"
        layers={[]}
        totalTokens={0}
        userMessage="これから送る入力"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("これから送る入力")).toBeInTheDocument();
  });
```

> 既存テスト(25-, systemPrompt のみ渡す)は `userMessage` が optional のため非回帰。`render` / `screen` の import は既存テスト先頭に準拠。

- [ ] **Step 2: テストが失敗することを確認**

Run: `pnpm test --run src/features/chat/components/PromptPreviewModal.test.tsx -t "送信メッセージ"`
Expected: FAIL — `userMessage` prop 未対応で本文が描画されない。

- [ ] **Step 3: PromptPreviewModal を実装**

prop 追加(`PromptPreviewModalProps`, 7-18):

```ts
  /** 「これから送る入力メッセージ」。空 / 未指定なら送信メッセージ行を描画しない。 */
  userMessage?: string;
```

分割代入(20-28)に `userMessage,` を追加。`{/* プロンプト全文 */}` セクション(183-190)の**直後**(同 `<>` 内、`</div>` の後)に送信メッセージセクションを追加:

```tsx
            {/* これから送る入力メッセージ */}
            {userMessage && userMessage.trim() && (
              <div>
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground uppercase">
                  {t("chat.context.outgoingMessage", "送信メッセージ")}
                </h3>
                <pre className="whitespace-pre-wrap rounded bg-muted p-3 text-xs text-foreground">
                  {userMessage}
                </pre>
              </div>
            )}
```

- [ ] **Step 4: ContextBar 配線**

`previewData` の state 型(166-170)に `userMessage` を追加:

```ts
  const [previewData, setPreviewData] = useState<{
    prompt: string;
    layers: LayerBreakdown[];
    totalTokens: number;
    userMessage: string;
  } | null>(null);
```

モーダル描画(910-919)に prop を渡す:

```tsx
        <PromptPreviewModal
          systemPrompt={previewData?.prompt ?? systemPrompt}
          layers={previewData?.layers ?? contextLayers}
          totalTokens={previewData?.totalTokens ?? contextTokenCount}
          userMessage={previewData?.userMessage ?? ""}
          model={model}
          contextWindow={contextWindow}
          loading={previewLoading}
          onClose={() => setPreviewOpen(false)}
        />
```

> `openPreview`(176-183)は `buildPreviewPrompt()` の戻り値をそのまま `setPreviewData` するため、`userMessage` を含む新しい戻り型と自動的に整合する。変更不要。

- [ ] **Step 5: i18n キー追加**

`src/locales/ja.json` の `chat.context` 内、`"emptyPrompt"`(1129)の直後に追加:

```json
      "outgoingMessage": "送信メッセージ",
```

`src/locales/en.json` の同位置(1129)に追加:

```json
      "outgoingMessage": "Outgoing message",
```

- [ ] **Step 6: テストが通ることを確認**

Run: `pnpm test --run src/features/chat/components/PromptPreviewModal.test.tsx`
Expected: PASS(既存 + 新規)。

- [ ] **Step 7: コミット**

```bash
git add src/features/chat/components/PromptPreviewModal.tsx src/features/chat/components/PromptPreviewModal.test.tsx src/features/chat/components/ContextBar.tsx src/locales/ja.json src/locales/en.json
git commit -m "$(cat <<'EOF'
feat(chat): プロンプトプレビューに送信メッセージ行を表示

PromptPreviewModal に userMessage セクションを追加し、ContextBar から
buildPreviewPrompt の入力テキストを受け渡す。プレビューが「system + 送信内容」
になる(③)。i18n キー chat.context.outgoingMessage 追加。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: stale JSDoc 是正 + 全体検証

**Files:**
- Modify: `src/features/chat/chatStore.ts`(`semanticRecallSeedMessage` JSDoc 1567-1570)

- [ ] **Step 1: stale コメントを是正**

`buildSceneContextPrompt` の `semanticRecallSeedMessage` JSDoc(1567-1570)を差し替え:

```ts
  /** semantic recall (Layer4 RAG) のクエリ seed に使う「これから送る本文」。
   * 送信 (sendMessage) は content、プレビュー / コピーは buildOutgoingScenePrompt
   * 経由で入力中テキスト(無ければ直近 user 発話 / 本文末尾)を渡す。未指定なら
   * semantic 検索は走らない — refreshContextLayers のライブ経路がこれに当たる。 */
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: エラーなし。

- [ ] **Step 3: chat スイート全体**

Run: `pnpm test --run src/features/chat`
Expected: 全 PASS。

- [ ] **Step 4: Lint**

Run: `pnpm lint:fix`
Expected: エラーなし(自動修正のみ)。

- [ ] **Step 5: コミット**

```bash
git add src/features/chat/chatStore.ts
git commit -m "$(cat <<'EOF'
docs(chat): semanticRecallSeedMessage の JSDoc を実態に是正

「プレビュー/コピーは検索が走らない」という旧記述を、入力中テキストを
seed に渡す現挙動へ更新。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 完了条件 / 検証

- `pnpm test --run src/features/chat` 緑
- `npx tsc --noEmit` 緑
- `pnpm lint:fix` 緑
- 手動 QA(実機, 別途): scene スコープで入力欄に文を打ち、
  1. プレビューを開く → 関連シーンが入力内容に応じて出る + 末尾に「送信メッセージ」行が出る
  2. 送信ボタン右クリック「プロンプトをコピー」→ `<related_scenes>` が含まれ、プレビュー / 実送信と一致
  3. eco(本文を含めない)ON で copy の system に本文が出ない

## スコープ外(本計画では触れない)

- 過去スナップショット経路(`getMessagePrompt` / `saveMessagePrompt`)
- スナップショット `layers/totalTokens` vs `systemPrompt` 微ズレ
- 非 scene スコープの RAG 化
