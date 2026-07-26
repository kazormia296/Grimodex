import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpSidecarMaterializer } from "./mcpSidecarInstall.js";

const tempRoots: string[] = [];

function fixture(): { root: string; source: string; userDataDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "grimodex-mcp-install-"));
  tempRoots.push(root);
  const source = path.join(root, "resources", "bin", "grimodex-mcp");
  const userDataDir = path.join(root, "user-data");
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, "#!/bin/sh\necho first\n");
  chmodSync(source, 0o755);
  return { root, source, userDataDir };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "linux")(
  "createMcpSidecarMaterializer",
  () => {
    it("atomically installs an executable into the stable userData bin directory", async () => {
      const { source, userDataDir } = fixture();
      const materialize = createMcpSidecarMaterializer();

      const installed = await materialize(source, userDataDir);

      expect(installed).toBe(path.join(userDataDir, "bin", "grimodex-mcp"));
      expect(readFileSync(installed, "utf8")).toBe("#!/bin/sh\necho first\n");
      expect(lstatSync(installed).mode & 0o777).toBe(0o755);
      expect(lstatSync(path.dirname(installed)).isDirectory()).toBeTruthy();
    });

    it("refreshes the stable executable when bundled content changes", async () => {
      const { source, userDataDir } = fixture();
      const materialize = createMcpSidecarMaterializer();
      const installed = await materialize(source, userDataDir);
      // Same byte length as "first": refresh must compare content, not size.
      writeFileSync(source, "#!/bin/sh\necho other\n");
      chmodSync(source, 0o755);

      await expect(materialize(source, userDataDir)).resolves.toBe(installed);
      expect(readFileSync(installed, "utf8")).toBe("#!/bin/sh\necho other\n");
    });

    it("leaves the returned stable executable usable after the resource disappears", async () => {
      const { source, userDataDir } = fixture();
      const installed = await createMcpSidecarMaterializer()(
        source,
        userDataDir,
      );

      rmSync(path.dirname(path.dirname(source)), { recursive: true });

      expect(readFileSync(installed, "utf8")).toContain("echo first");
      expect(lstatSync(installed).mode & 0o111).not.toBe(0);
      expect(execFileSync(installed, { encoding: "utf8" })).toBe("first\n");
    });

    it.each(["directory", "symlink"])(
      "rejects a %s source without replacing a good destination",
      async (kind) => {
        const { root, source, userDataDir } = fixture();
        const materialize = createMcpSidecarMaterializer();
        const installed = await materialize(source, userDataDir);
        const invalid = path.join(root, `invalid-${kind}`);
        if (kind === "directory") {
          mkdirSync(invalid);
        } else {
          symlinkSync(source, invalid, "file");
        }

        await expect(materialize(invalid, userDataDir)).rejects.toThrow(
          /regular non-symlink file/i,
        );
        expect(readFileSync(installed, "utf8")).toContain("echo first");
      },
    );

    it("coalesces concurrent installs for the same stable destination", async () => {
      const { source, userDataDir } = fixture();
      let releaseRename: (() => void) | undefined;
      const renameGate = new Promise<void>((resolve) => {
        releaseRename = resolve;
      });
      const rename = vi.fn(async (temporary: string, destination: string) => {
        await renameGate;
        const { rename: realRename } = await import("node:fs/promises");
        await realRename(temporary, destination);
      });
      const materialize = createMcpSidecarMaterializer({ rename });

      const first = materialize(source, userDataDir);
      const second = materialize(source, userDataDir);
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      releaseRename?.();

      await expect(Promise.all([first, second])).resolves.toEqual([
        path.join(userDataDir, "bin", "grimodex-mcp"),
        path.join(userDataDir, "bin", "grimodex-mcp"),
      ]);
      expect(rename).toHaveBeenCalledTimes(1);
    });

    it("preserves a known-good executable when the atomic replacement fails", async () => {
      const { source, userDataDir } = fixture();
      const installed = await createMcpSidecarMaterializer()(
        source,
        userDataDir,
      );
      writeFileSync(source, "#!/bin/sh\necho replacement\n");
      chmodSync(source, 0o755);
      const materialize = createMcpSidecarMaterializer({
        rename: vi.fn(async () => {
          throw Object.assign(new Error("injected rename failure"), {
            code: "EIO",
          });
        }),
      });

      await expect(materialize(source, userDataDir)).rejects.toThrow(
        /injected rename failure/,
      );
      expect(readFileSync(installed, "utf8")).toContain("echo first");
    });
  },
);
