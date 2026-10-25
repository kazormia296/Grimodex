import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isEditTargetCurrent,
  isNonSceneEditClosed,
  isSceneConversation,
  snapshotEditTarget,
  type EditTargetState,
} from "./chatEgressClosure";

// DA-2b の PUB-G 前の必須 1（DR-DA2B-R17）：非場面の会話の編集の閉鎖の純関数と、
// `editUserMessage`（行を消す）を呼ぶ製品の入口の静的な固定。

describe("isNonSceneEditClosed（fail-closed）", () => {
  it.each([
    [{ state: "unrestricted" }, false],
    [{ state: "restricted" }, true],
    [{ state: "activating" }, true],
    [{ state: "unavailable", reason: "status-invalid" }, true],
    [{ state: "unrestricted", extra: true }, true],
    [{ state: "UNRESTRICTED" }, true],
    [{}, true],
    [[{ state: "unrestricted" }], true],
    [null, true],
    [undefined, true],
    ["unrestricted", true],
    [new Error("PROFILE_EGRESS_STATUS_UNAVAILABLE"), true],
  ] as Array<[unknown, boolean]>)("%o → 閉 %s", (outcome, closed) => {
    expect(isNonSceneEditClosed(outcome)).toBe(closed);
  });
});

const base: EditTargetState = {
  chatScope: "scene",
  activeSceneId: "scene-1",
  scopeAnchorId: null,
  threadFocusOverride: null,
  activeProjectId: "p1",
  activeSessionId: "s1",
  isStreaming: false,
  messages: [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
    { id: "u2", role: "user" },
  ],
};

describe("isSceneConversation（capture の会話の条件と同じ）", () => {
  it.each([
    [{}, true],
    [{ chatScope: "project" }, false],
    [{ chatScope: "folder", scopeAnchorId: "f1" }, false],
    [{ chatScope: "codex", scopeAnchorId: "c1" }, false],
    [{ chatScope: "snippet", scopeAnchorId: "n1" }, false],
    [{ activeSceneId: "" }, false],
    [{ scopeAnchorId: "x" }, false],
    [{ threadFocusOverride: { threadId: "t", title: "t" } }, false],
  ] as Array<[Partial<EditTargetState>, boolean]>)(
    "%o → 場面の会話 %s",
    (patch, scene) => {
      expect(isSceneConversation({ ...base, ...patch })).toBe(scene);
    },
  );
});

describe("isEditTargetCurrent", () => {
  const project: EditTargetState = { ...base, chatScope: "project" };
  const snap = snapshotEditTarget(project, "u1");

  it("同じなら真", () => {
    expect(isEditTargetCurrent(snap, project)).toBe(true);
  });

  it.each([
    [{ activeProjectId: "p2" }],
    [{ activeSessionId: "s2" }],
    [{ isStreaming: true }],
    [{ messages: [{ id: "a1", role: "assistant" }] }],
    [
      {
        messages: [...base.messages, { id: "a2", role: "assistant" }],
      },
    ],
    [{ chatScope: "scene" }],
  ] as Array<[Partial<EditTargetState>]>)("%o では偽", (patch) => {
    expect(isEditTargetCurrent(snap, { ...project, ...patch })).toBe(false);
  });

  it("最後の user 行の後ろに行が足されたら偽（入力欄の最後の行の編集）", () => {
    const last = snapshotEditTarget(project, "u2");
    expect(isEditTargetCurrent(last, project)).toBe(true);
    expect(
      isEditTargetCurrent(last, {
        ...project,
        messages: [...project.messages, { id: "u3", role: "user" }],
      }),
    ).toBe(false);
  });
});

const repo = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repo, path), "utf8");
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function productSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(repo, dir), {
    withFileTypes: true,
  })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productSources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
      out.push(relative(repo, resolve(repo, path)));
  }
  return out;
}

/** `from "…"` と副作用だけの `import "…"` の両方（動的 import の `import("…")` は含まない）。 */
const STATIC_STATUS_IMPORT =
  /(?:\bfrom\s+|\bimport\s+)"@\/lib\/profileEgressStatus"/;

const EDIT_ENTRANCES = [
  "src/features/chat/components/ChatInput.tsx",
  "src/features/chat/useChatMessageActions.ts",
];

describe("editUserMessage を呼ぶ製品の入口（静的）", () => {
  const sources = productSources("src");

  it("呼ぶのは 2 つの入口だけ", () => {
    const callers = sources.filter((file) =>
      /\beditUserMessage\s*\(/.test(code(read(file))),
    );
    expect(callers.sort()).toEqual([...EDIT_ENTRANCES].sort());
  });

  it.each(EDIT_ENTRANCES)("%s は guard の proceed の中でだけ呼ぶ", (file) => {
    const body = code(read(file));
    expect(body.match(/\beditUserMessage\s*\(/g)).toHaveLength(1);
    expect(body.match(/\badmitConversationEdit\s*\(/g)).toHaveLength(1);
    // 削除の前提の editor の確認は isCurrent の中（R21。同期の経路でも確かめる）。
    expect(body).toMatch(
      /isCurrent:\s*\(\)\s*=>[\s\S]*?isDestroyed[\s\S]*?isEditTargetCurrent\(/,
    );
    // snapshot → admit（sceneConversation は snapshot から）→ proceed の中の呼出し。
    expect(body).toMatch(
      /snapshotEditTarget\(\s*useChatStore\.getState\(\),[\s\S]*?admitConversationEdit\(\{\s*sceneConversation:\s*target\.sceneConversation,\s*isCurrent:[\s\S]*?isEditTargetCurrent\(\s*target,\s*useChatStore\.getState\(\)[\s\S]*?proceed:\s*\(\)\s*=>\s*\{\s*const \{ content, mentionedSceneIds \} = editUserMessage\(/,
    );
  });

  it("状態の wrapper は動的 import だけ（起動時の graph と preload の表を増やさない）", () => {
    const body = code(read("src/features/chat/chatEgressClosure.ts"));
    expect(body).toMatch(/await import\("@\/lib\/profileEgressStatus"\)/);
    expect(body).not.toMatch(STATIC_STATUS_IMPORT);
    expect(body).not.toMatch(/from\s+"@\/lib\/shell"/);
    for (const file of sources.filter((f) =>
      f.startsWith("src/features/chat/"),
    )) {
      expect(
        STATIC_STATUS_IMPORT.test(code(read(file))),
        `${file} imports the status wrapper statically`,
      ).toBe(false);
    }
  });
});
