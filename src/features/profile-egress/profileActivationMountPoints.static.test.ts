import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// NIR-1 DA-2 ST3-S6 (DR-DA2-30): while `PROFILE_ACTIVATION_UI_ENABLED` is
// false the bundler drops the closed branches, the lazy imports and their
// chunks only because the mount points read the constant itself and mark the
// `lazy()` that requests the chunk pure. A function in between (or an
// unmarked `lazy()`) keeps them in the build without failing any rendering
// test, so this test reads the sources.

const repo = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repo, path), "utf8");
const CONSTANT = "PROFILE_ACTIVATION_UI_ENABLED";

/** Every product file that reads the constant, and the chunk it requests. */
const MOUNT_POINTS: ReadonlyArray<{
  readonly file: string;
  readonly lazyModule: string | null;
  /** The lazy component the file mounts (null when it mounts none). */
  readonly component?: string;
  /** A variable that holds the constant's condition, when the mount reads it. */
  readonly guardVariable?: string;
}> = [
  {
    file: "src/features/profile-egress/ProfileEgressStatusSlot.tsx",
    lazyModule: "./ProfileEgressStatusIndicator",
    component: "ProfileEgressStatusIndicator",
  },
  {
    file: "src/features/settings/categories/DataCategory.tsx",
    lazyModule: "@/features/profile-egress/ProfileActivationSettingsSection",
    component: "ProfileActivationSettingsSection",
  },
  {
    file: "src/features/related-scenes/Nir1GraphRelatedScenes.tsx",
    lazyModule: "@/features/profile-egress/ProfileActivationGuidance",
    component: "ProfileActivationGuidance",
    guardVariable: "profileNotRestricted",
  },
  // Decides whether the Graph chunk (itself behind the Graph constant) is
  // requested for `profile-not-restricted`; it requests no chunk of its own.
  {
    file: "src/features/related-scenes/RelatedScenesSection.tsx",
    lazyModule: null,
  },
  // DA-2b ST4-B (DR-DA2B-R6): the chat panel's closed AI entrances. The panel
  // requests the probe; the input and the message actions only read the
  // closure the panel passes down.
  {
    file: "src/features/chat/ChatPanel.tsx",
    lazyModule: "@/features/profile-egress/ProfileEgressChatClosureProbe",
    component: "ProfileEgressChatClosureProbe",
  },
  { file: "src/features/chat/components/ChatInput.tsx", lazyModule: null },
  { file: "src/features/chat/useChatMessageActions.ts", lazyModule: null },
  // The non-scene edit closure (DR-DA2B-R17): the constant only picks the
  // closed notice; the closure itself does not depend on it.
  { file: "src/features/chat/chatEgressClosure.ts", lazyModule: null },
  // The import's notice of the conversations not taken in (DR-DA2B-R7).
  { file: "src/features/import/chatImportNotice.ts", lazyModule: null },
  // The other AI entrances' closure (PUB-G 前の必須 3・4, DR-DA2B-R22〜R24):
  // the local refusal before IPC, the visible controls, the conversation
  // creation and the A/B adoption, the Spotlight's notice and the phone chat.
  { file: "src/lib/tauri.ts", lazyModule: null },
  { file: "src/features/ai-policy/useAiGate.ts", lazyModule: null },
  {
    file: "src/application/chat/chatSessionStoreActions.ts",
    lazyModule: null,
  },
  {
    file: "src/application/chat/chatPersistenceStoreActions.ts",
    lazyModule: null,
  },
  { file: "src/features/chat/useChatPinsController.ts", lazyModule: null },
  {
    file: "src/features/layout/adaptive/MobileWorkspaceSurfaces.tsx",
    lazyModule: null,
  },
];

/** The lazy chunks behind the constant: never imported statically. */
const LAZY_MODULES = [
  "ProfileEgressStatusIndicator",
  "ProfileEgressChatClosureProbe",
  "ProfileActivationSettingsSection",
  "ProfileActivationGuidance",
];

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

/** The source without comments (the constant is named in many of them). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

const sources = productSources("src");

describe("the closed profile activation UI stays out of the build (ST3-S6, DR-DA2-30)", () => {
  it("is one plain constant, with nothing else exported beside it", () => {
    const module = code(
      read("src/features/profile-egress/profileActivationAvailability.ts"),
    ).trim();
    expect(module).toBe(`export const ${CONSTANT} = false as const;`);
  });

  it("is read only by the listed mount points", () => {
    const readers = sources.filter((file) =>
      new RegExp(`\\b${CONSTANT}\\b`).test(code(read(file))),
    );
    expect(readers.sort()).toEqual(
      [
        "src/features/profile-egress/profileActivationAvailability.ts",
        ...MOUNT_POINTS.map(({ file }) => file),
      ].sort(),
    );
  });

  it.each(MOUNT_POINTS)(
    "$file reads the constant itself and marks its lazy() pure",
    ({ file, lazyModule }) => {
      const source = read(file);
      const body = code(source);
      // A named import of the constant, not a namespace or a renamed binding.
      expect(body).toMatch(
        new RegExp(
          `import \\{ ${CONSTANT} \\} from "(?:\\./|@/features/profile-egress/)profileActivationAvailability";`,
        ),
      );
      // Read directly in a condition.
      expect(body).toMatch(
        new RegExp(`\\b${CONSTANT}\\s*(?:&&|\\?)|if \\(${CONSTANT}\\) \\{`),
      );
      // Never through a function, a plain alias or a call.
      expect(body).not.toMatch(/\bisProfileActivationUi\w*\s*\(/);
      expect(body).not.toMatch(new RegExp(`\\b${CONSTANT}\\s*\\(`));
      expect(body).not.toMatch(
        new RegExp(`(?:const|let|var)\\s+\\w+\\s*=\\s*${CONSTANT}\\s*[;,)]`),
      );
      if (lazyModule === null) return;
      const lazyCalls = source.match(/(?:\/\* @__PURE__ \*\/ )?lazy\(/g) ?? [];
      expect(lazyCalls).toEqual(["/* @__PURE__ */ lazy("]);
      expect(source).toMatch(
        new RegExp(
          `/\\* @__PURE__ \\*/ lazy\\(\\(\\) =>\\s*import\\("${escape(lazyModule)}"\\)`,
        ),
      );
    },
  );

  // DA-2b acceptance (mutation 16b): the checks above are satisfied by any
  // other `CONSTANT &&` in the file, so a lazy part mounted outside the
  // constant (which would call `get_profile_egress_status` while the constant
  // is false) passed them. The mount itself must sit directly under it.
  it.each(MOUNT_POINTS.filter(({ component }) => component !== undefined))(
    "$file mounts $component only under the constant",
    ({ file, component, guardVariable }) => {
      const body = code(read(file));
      const mount = `<Suspense[^>]*>\\s*<${component}\\b`;
      if (guardVariable === undefined) {
        expect(body).toMatch(
          new RegExp(`${CONSTANT}\\s*(?:&&|\\?)\\s*\\(\\s*${mount}`),
        );
      } else {
        expect(body).toMatch(
          new RegExp(
            `(?:const|let)\\s+${guardVariable}\\s*=\\s*${CONSTANT}\\s*&&`,
          ),
        );
        expect(body).toMatch(
          new RegExp(`\\{${guardVariable}\\s*&&\\s*\\(\\s*${mount}`),
        );
      }
      // Exactly one mount of the component, so a second one cannot hide.
      expect(body.match(new RegExp(`<${component}\\b`, "g"))?.length).toBe(1);
    },
  );

  it("never imports a lazy chunk statically", () => {
    for (const file of sources) {
      const body = code(read(file));
      for (const name of LAZY_MODULES) {
        expect(
          new RegExp(`from\\s+"[^"]*/${name}"`).test(body),
          `${file} imports ${name} statically`,
        ).toBe(false);
      }
    }
  });

  // DA-2b W-1 (DR-DA2B-R8): the retry after the activation is code of the
  // status display's lazy chunk only, so it is not in the startup graph.
  it("reaches the W-1 retry only from the status display's lazy chunk", () => {
    const importers = sources.filter((file) =>
      /from\s+"[^"]*\/profileActivationWriteRetry"/.test(code(read(file))),
    );
    expect(importers).toEqual([
      "src/features/profile-egress/ProfileEgressStatusIndicator.tsx",
    ]);
    // Reaching the root of the startup chunk it calls into keeps that chunk
    // whole (without it the startup graph grows by about 1 KB).
    expect(
      code(read("src/features/profile-egress/profileActivationWriteRetry.ts")),
    ).toMatch(/^import "@\/features\/project\/projectStore";$/m);
  });

  // PUB-G 前の必須 3・4 (DR-DA2B-R23): while the constant is false the closure
  // adds nothing to the startup graph only because no startup chunk refers to
  // a symbol it did not already import. A reference from another chunk keeps
  // an export and an import even when the call is gone (measured: +23 to +244
  // bytes), so the homes of the closure are read only as follows.
  it("keeps the local refusal's ledger out of the startup chunks", () => {
    // Only the status display's lazy writer imports the ledger; the startup
    // `tauri` chunk reads the global the writer sets, under the constant only.
    const importers = sources.filter((file) =>
      /from\s+"[^"]*\/profileEgressClosure"/.test(code(read(file))),
    );
    expect(importers).toEqual([
      "src/features/chat/closeProfileEgressEntrances.ts",
    ]);
    expect(
      code(read("src/features/profile-egress/profileEgressClosure.ts")),
    ).not.toMatch(/^\s*import\b/m);
    expect(code(read("src/lib/tauri.ts"))).toMatch(
      /if \(PROFILE_ACTIVATION_UI_ENABLED\) \{\s*const refusal =\s*globalThis\.__grimodexProfileEgressLocalRefusal\?\.\(cmd\) \?\? null;/,
    );
  });

  it("writes the closure only from the status display's lazy chunk", () => {
    const importers = sources.filter((file) =>
      /from\s+"[^"]*\/closeProfileEgressEntrances"/.test(code(read(file))),
    );
    expect(importers).toEqual([
      "src/features/profile-egress/ProfileEgressStatusIndicator.tsx",
    ]);
    const globalUsers = sources.filter((file) =>
      /__grimodexProfileEgressLocalRefusal/.test(code(read(file))),
    );
    expect(globalUsers.sort()).toEqual([
      "src/features/chat/closeProfileEgressEntrances.ts",
      "src/features/profile-egress/profileEgressClosure.ts",
      "src/lib/tauri.ts",
    ]);
    // Set once as a property that cannot be written, deleted or redefined
    // (one-way, DR-DA2B-R27); nothing assigns it.
    const writer = code(
      read("src/features/chat/closeProfileEgressEntrances.ts"),
    );
    expect(
      writer.match(
        /Object\.defineProperty\(globalThis, "__grimodexProfileEgressLocalRefusal", \{\s*value: profileEgressLocalRefusal,\s*writable: false,\s*configurable: false,/g,
      )?.length,
    ).toBe(1);
    for (const file of globalUsers) {
      expect(code(read(file)), file).not.toMatch(
        /__grimodexProfileEgressLocalRefusal\s*=(?!=)/,
      );
    }
  });

  it("reads the store's closure only under the constant, in the listed files", () => {
    const readers = sources.filter((file) =>
      /\bprofileEgressClosed\b/.test(code(read(file))),
    );
    expect(readers.sort()).toEqual(
      [
        "src/application/chat/chatPersistenceStoreActions.ts",
        "src/application/chat/chatSessionStoreActions.ts",
        "src/features/ai-policy/useAiGate.ts",
        "src/features/chat/store.ts",
        "src/features/chat/useChatPinsController.ts",
        "src/features/layout/adaptive/MobileWorkspaceSurfaces.tsx",
        "src/features/chat/closeProfileEgressEntrances.ts",
      ].sort(),
    );
    // The hook reads sit directly behind the constant's ternary.
    for (const file of [
      "src/features/ai-policy/useAiGate.ts",
      "src/features/layout/adaptive/MobileWorkspaceSurfaces.tsx",
    ]) {
      expect(code(read(file))).toMatch(
        new RegExp(
          `${CONSTANT}\\s*\\?\\s*useAiSettingsStore\\(\\s*\\(\\w+\\) => \\w+\\.profileEgressClosed === true`,
        ),
      );
    }
    // The store actions call the closure only behind the constant.
    const session = code(
      read("src/application/chat/chatSessionStoreActions.ts"),
    );
    expect(session.match(/refuseNewConversation\(\)/g)?.length).toBe(3);
    expect(
      session.match(
        new RegExp(`${CONSTANT} && refuseNewConversation\\(\\)`, "g"),
      )?.length,
    ).toBe(3);
  });

  it("passes the chat send's feature only through the constant's ternary", () => {
    const users = sources.filter((file) =>
      /(?<!data-testid=)"chat-send"/.test(code(read(file))),
    );
    expect(users.sort()).toEqual(
      [
        "src/features/ai-policy/useAiGate.ts",
        "src/features/chat/ChatPanel.tsx",
        "src/features/layout/adaptive/MobileWorkspaceSurfaces.tsx",
      ].sort(),
    );
    for (const file of [
      "src/features/chat/ChatPanel.tsx",
      "src/features/layout/adaptive/MobileWorkspaceSurfaces.tsx",
    ]) {
      expect(code(read(file))).toMatch(
        new RegExp(
          `useAiGate\\(\\s*${CONSTANT} \\? "chat-send" : "chat",?\\s*\\)`,
        ),
      );
    }
  });

  // DR-DA2B-R26: the Enter submit reaches `onSend` without the send button, so
  // the chat panel's send closure is checked there too, under the constant.
  it("checks the chat send's closure in onSend, under the constant", () => {
    const body = code(read("src/features/chat/ChatPanel.tsx"));
    expect(
      body.match(/if \(([\w ]*&& )?egressSendClosed\) return false;/g),
    ).toEqual([`if (${CONSTANT} && egressSendClosed) return false;`]);
  });
});
