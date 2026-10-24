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
}> = [
  {
    file: "src/features/profile-egress/ProfileEgressStatusSlot.tsx",
    lazyModule: "./ProfileEgressStatusIndicator",
  },
  {
    file: "src/features/settings/categories/DataCategory.tsx",
    lazyModule: "@/features/profile-egress/ProfileActivationSettingsSection",
  },
  {
    file: "src/features/related-scenes/Nir1GraphRelatedScenes.tsx",
    lazyModule: "@/features/profile-egress/ProfileActivationGuidance",
  },
  // Decides whether the Graph chunk (itself behind the Graph constant) is
  // requested for `profile-not-restricted`; it requests no chunk of its own.
  {
    file: "src/features/related-scenes/RelatedScenesSection.tsx",
    lazyModule: null,
  },
];

/** The lazy chunks behind the constant: never imported statically. */
const LAZY_MODULES = [
  "ProfileEgressStatusIndicator",
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
      expect(body).toMatch(new RegExp(`\\b${CONSTANT}\\s*(?:&&|\\?)`));
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
});
