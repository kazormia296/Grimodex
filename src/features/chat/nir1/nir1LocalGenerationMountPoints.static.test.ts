import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// NIR-1 DD-1c (DR-DD1C-1, -2): while `NIR1_LOCAL_GENERATION_UI_ENABLED` is
// false the bundler drops the closed branches and the lazy imports only
// because the mount points read the constant itself and mark their `lazy()`
// pure. A function in between, an unmarked `lazy()` or a static import of a
// lazy module keeps them in the build without failing any rendering test, so
// this test reads the sources (the pattern of
// `profileActivationMountPoints.static.test.ts`).

const repo = resolve(__dirname, "../../../..");
const read = (path: string) => readFileSync(resolve(repo, path), "utf8");
const CONSTANT = "NIR1_LOCAL_GENERATION_UI_ENABLED";
const NIR1_DIR = "src/features/chat/nir1/";

/** Every product file that reads the constant and what it mounts. */
const MOUNT_POINTS: ReadonlyArray<{
  readonly file: string;
  readonly component: string;
  /** The lazy module the file requests itself (null: through a slot). */
  readonly lazyModule: string | null;
  /** An extra condition beside the constant. */
  readonly extraCondition?: string;
}> = [
  {
    file: "src/features/chat/ChatPanel.tsx",
    component: "Nir1LocalGenerationSlot",
    lazyModule: null,
  },
  {
    file: "src/features/chat/nir1/Nir1LocalGenerationSlot.tsx",
    component: "Nir1LocalGenerationPanel",
    lazyModule: "./Nir1LocalGenerationPanel",
  },
  {
    file: "src/features/settings/categories/OpenaiCompatibleEndpointsManager.tsx",
    component: "Nir1LocalDisclosure",
    lazyModule: "@/features/chat/nir1/Nir1LocalDisclosure",
  },
  {
    file: "src/features/settings/categories/AiProjectSettings.tsx",
    component: "Nir1LocalDisclosure",
    lazyModule: "@/features/chat/nir1/Nir1LocalDisclosure",
  },
  {
    file: "src/features/profile-egress/ProfileEgressStatusIndicator.tsx",
    component: "Nir1LocalDisclosure",
    lazyModule: "@/features/chat/nir1/Nir1LocalDisclosure",
    extraCondition: "restricted",
  },
];

/** The modules of the lazy chunks: never imported (as values) from outside. */
const LAZY_ONLY_MODULES = [
  "Nir1LocalGenerationPanel",
  "Nir1LocalDisclosure",
  "nir1LocalGenerationApi",
  "nir1LocalGenerationStore",
  "nir1LocalGenerationTranslations",
  "nir1LocalPolicyGate",
  "nir1LocalRoutePreview",
  "nir1LocalDisclosureItems",
  "nir1LocalGenerationTurn",
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

/** Value imports (static or dynamic) of `name`; `import type` is erased. */
function valueImportsOf(body: string, name: string): boolean {
  const statics = [
    ...body.matchAll(/import\s+(type\s+)?[^"']*?from\s+"([^"]+)"/g),
  ].filter(([, type, from]) => !type && from.endsWith(`/${name}`));
  const dynamics = new RegExp(`\\bimport\\s*\\(\\s*"[^"]*/${name}"`).test(body);
  return statics.length > 0 || dynamics;
}

const sources = productSources("src");

describe("the closed local generation UI stays out of the build (DR-DD1C-1, -2)", () => {
  it("is one plain constant, false, with nothing else exported", () => {
    expect(
      code(read(`${NIR1_DIR}nir1LocalGenerationAvailability.ts`)).trim(),
    ).toBe(`export const ${CONSTANT} = false as const;`);
  });

  it("is read only by the listed mount points", () => {
    const readers = sources.filter((file) =>
      new RegExp(`\\b${CONSTANT}\\b`).test(code(read(file))),
    );
    expect(readers.sort()).toEqual(
      [
        `${NIR1_DIR}nir1LocalGenerationAvailability.ts`,
        ...MOUNT_POINTS.map(({ file }) => file),
      ].sort(),
    );
  });

  it.each(MOUNT_POINTS)(
    "$file reads the constant itself and mounts $component only under it",
    ({ file, component, lazyModule, extraCondition }) => {
      const source = read(file);
      const body = code(source);
      expect(body).toMatch(
        new RegExp(
          `import \\{ ${CONSTANT} \\} from "(?:\\./|\\./nir1/|@/features/chat/nir1/)nir1LocalGenerationAvailability";`,
        ),
      );
      expect(body).not.toMatch(new RegExp(`\\b${CONSTANT}\\s*\\(`));
      expect(body).not.toMatch(
        new RegExp(`(?:const|let|var)\\s+\\w+\\s*=\\s*${CONSTANT}\\s*[;,)]`),
      );
      const guard =
        extraCondition === undefined
          ? `${CONSTANT}\\s*(?:&&|\\?)`
          : `${CONSTANT}\\s*&&\\s*${extraCondition}\\s*&&`;
      const mount =
        lazyModule === null
          ? `<${component}\\b`
          : `<Suspense[^>]*>\\s*<${component}\\b`;
      expect(body).toMatch(new RegExp(`${guard}\\s*\\(\\s*${mount}`));
      expect(body.match(new RegExp(`<${component}\\b`, "g"))?.length).toBe(1);
      if (lazyModule === null) return;
      const lazyCalls = source.match(/(?:\/\* @__PURE__ \*\/ )?lazy\(/g) ?? [];
      expect(
        lazyCalls.filter((call) => call === "/* @__PURE__ */ lazy("),
      ).toEqual(lazyCalls);
      expect(source).toMatch(
        new RegExp(
          `const ${component} = /\\* @__PURE__ \\*/ lazy\\(\\(\\) =>\\s*import\\("${escape(lazyModule)}"\\)`,
        ),
      );
    },
  );

  it("keeps the lazy modules out of every other import", () => {
    // Allowed value importers: the slot and the hosts' lazy imports, and the
    // lazy chunk's own modules (they import one another).
    for (const file of sources) {
      if (file.startsWith(NIR1_DIR)) continue;
      const body = code(read(file));
      for (const name of LAZY_ONLY_MODULES) {
        if (!valueImportsOf(body, name)) continue;
        const host = MOUNT_POINTS.find(
          (point) =>
            point.file === file &&
            point.lazyModule !== null &&
            point.lazyModule.endsWith(`/${name}`),
        );
        const ownChunk =
          file === "src/application/chat/nir1LocalGenerationTurn.ts" &&
          name === "nir1LocalGenerationApi";
        expect(host !== undefined || ownChunk, `${file} imports ${name}`).toBe(
          true,
        );
      }
    }
    // The state machine is imported only by the lazy chunk's store and panel.
    const turnImporters = sources.filter((file) =>
      valueImportsOf(code(read(file)), "nir1LocalGenerationTurn"),
    );
    expect(turnImporters.sort()).toEqual(
      [
        `${NIR1_DIR}Nir1LocalGenerationPanel.tsx`,
        `${NIR1_DIR}nir1LocalGenerationStore.ts`,
      ].sort(),
    );
  });

  it("starts the generation from an accepted send only under the constant", () => {
    const body = code(read("src/features/chat/ChatPanel.tsx"));
    expect(body.match(/nir1LocalAcceptedRef\.current\?\.\(/g)?.length).toBe(1);
    expect(body).toMatch(
      new RegExp(
        `if \\(${CONSTANT} && nir1LocalSend\\) \\{\\s*nir1LocalAcceptedRef\\.current\\?\\.\\(nir1LocalSend\\);`,
      ),
    );
    expect(body).toMatch(new RegExp(`const nir1LocalSend =\\s*${CONSTANT} &&`));
  });
});

describe("what the local generation renderer never does (DR-DD1C-3〜7)", () => {
  const files = [
    ...sources.filter((file) => file.startsWith(NIR1_DIR)),
    "src/application/chat/nir1LocalGenerationTurn.ts",
  ];

  it("keeps handles and outputs out of storage, logs and events", () => {
    for (const file of files) {
      expect(code(read(file)), file).not.toMatch(
        /localStorage|sessionStorage|indexedDB|debugLog|console\.|postMessage|dispatchEvent|BroadcastChannel/,
      );
    }
  });

  it("never cancels the capture itself (one cancel command, K4/3:445-451)", () => {
    for (const file of files) {
      expect(code(read(file)), file).not.toMatch(
        /cancel_current_chat_input|cancelCurrentChatInput|retire_current_chat_input/,
      );
    }
    const api = code(read(`${NIR1_DIR}nir1LocalGenerationApi.ts`));
    expect(
      [...api.matchAll(/"(nir1_local_[a-z_]+)"/g)].map(
        ([, command]) => command,
      ),
    ).toEqual([
      "nir1_local_generation_start",
      "nir1_local_generation_continue",
      "nir1_local_generation_cancel",
      "nir1_local_conversation_create",
      "nir1_local_conversation_list",
      "nir1_local_conversation_read",
    ]);
  });

  it("leaves the chat context builder and the turn store actions untouched", () => {
    for (const file of [
      "src/features/chat/contextBuilder.ts",
      "src/application/chat/chatTurnStoreActions.ts",
      "src/application/chat/chatTurnLifecycle.ts",
    ]) {
      expect(read(file), file).not.toMatch(/nir1Local|nir1_local_generation/);
    }
  });

  it("keeps its strings out of the startup locale files", () => {
    for (const locale of readdirSync(resolve(repo, "src/locales"))) {
      if (!locale.endsWith(".json")) continue;
      expect(read(`src/locales/${locale}`), locale).not.toContain("nir1Local");
    }
  });
});
