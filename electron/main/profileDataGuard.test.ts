/**
 * profileDataGuard の単体テスト（K3/2 SF-1。DA-1）。実一時 directory と symlink で、
 * canonical path と identity の比較、存在しない保存先、fail closed を固定する。
 */
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROFILE_DATA_GUARD_ERROR_CODE,
  ProfileDataGuardError,
  createProfileDataGuard,
  isInsideCanonicalPath,
} from "./profileDataGuard.js";

let base = "";
let profile = "";
let documents = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "grim-pdg-")));
  profile = path.join(base, "userData");
  documents = path.join(base, "documents");
  mkdirSync(path.join(profile, "bin"), { recursive: true });
  mkdirSync(documents);
  writeFileSync(path.join(profile, "profile-egress.json"), "{}");
  writeFileSync(path.join(documents, "note.md"), "# n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function reason(promise: Promise<void>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => {
      expect(error).toBeInstanceOf(ProfileDataGuardError);
      expect((error as ProfileDataGuardError).code).toBe(
        PROFILE_DATA_GUARD_ERROR_CODE,
      );
      return (error as ProfileDataGuardError).reason;
    },
  );
}

describe("isInsideCanonicalPath", () => {
  it("等しい／下は true、同じ接頭辞の兄弟は false（境界安全）", () => {
    expect(isInsideCanonicalPath("/a/userData", "/a/userData", "linux")).toBe(
      true,
    );
    expect(
      isInsideCanonicalPath("/a/userData/x/y", "/a/userData", "linux"),
    ).toBe(true);
    expect(
      isInsideCanonicalPath("/a/userData2/x", "/a/userData", "linux"),
    ).toBe(false);
    expect(isInsideCanonicalPath("/a", "/a/userData", "linux")).toBe(false);
  });

  it("Windows と macOS は大文字小文字を区別せず、Linux は区別する", () => {
    expect(
      isInsideCanonicalPath(
        "C:\\Users\\X\\APPDATA\\Grimodex\\profile-egress.json",
        "c:\\users\\x\\appdata\\grimodex",
        "win32",
      ),
    ).toBe(true);
    expect(
      isInsideCanonicalPath("/Users/x/LIBRARY/a", "/users/x/library", "darwin"),
    ).toBe(true);
    expect(isInsideCanonicalPath("/A/userdata/x", "/A/userData", "linux")).toBe(
      false,
    );
  });
});

describe("assertOutside", () => {
  const guard = () => createProfileDataGuard(() => profile);

  it("profile data directory の外は通る（存在しない保存先を含む）", async () => {
    await expect(
      guard().assertOutside(path.join(documents, "note.md")),
    ).resolves.toBeUndefined();
    await expect(
      guard().assertOutside(path.join(documents, "new", "deep", "out.txt")),
    ).resolves.toBeUndefined();
    // 同じ接頭辞の兄弟
    mkdirSync(path.join(base, "userData2"));
    await expect(
      guard().assertOutside(path.join(base, "userData2", "x.json")),
    ).resolves.toBeUndefined();
    // profile data directory を含む folder の中の file（祖先の鎖に profile は入らない）
    await expect(
      guard().assertOutside(path.join(base, "top.md")),
    ).resolves.toBeUndefined();
  });

  it("profile data directory の中は拒否する（既存の file、directory、存在しない保存先）", async () => {
    for (const target of [
      path.join(profile, "profile-egress.json"),
      profile,
      path.join(profile, "bin"),
      path.join(profile, "bin", "grimodex-mcp"),
      path.join(profile, "new-file.json"),
      path.join(profile, "a", "b", "c.json"),
    ]) {
      expect(await reason(guard().assertOutside(target))).toBe(
        "inside-profile-data-directory",
      );
    }
  });

  it("symlink を解決した実体で比べる（file／directory／鎖）", async () => {
    symlinkSync(
      path.join(profile, "profile-egress.json"),
      path.join(documents, "file-link"),
    );
    symlinkSync(profile, path.join(documents, "dir-link"), "dir");
    symlinkSync(
      path.join(documents, "dir-link"),
      path.join(documents, "chain"),
    );
    for (const target of [
      path.join(documents, "file-link"),
      path.join(documents, "dir-link", "profile-egress.json"),
      path.join(documents, "dir-link", "not-yet.json"),
      path.join(documents, "chain", "profile-egress.json"),
    ]) {
      expect(await reason(guard().assertOutside(target))).toBe(
        "inside-profile-data-directory",
      );
    }
  });

  it("profile data directory 自体が symlink でも成り立つ", async () => {
    const link = path.join(base, "profile-link");
    symlinkSync(profile, link, "dir");
    const viaLink = createProfileDataGuard(() => link);
    expect(
      await reason(
        viaLink.assertOutside(path.join(profile, "profile-egress.json")),
      ),
    ).toBe("inside-profile-data-directory");
    expect(
      await reason(
        viaLink.assertOutside(path.join(link, "profile-egress.json")),
      ),
    ).toBe("inside-profile-data-directory");
    await expect(
      viaLink.assertOutside(path.join(documents, "note.md")),
    ).resolves.toBeUndefined();
  });

  it("dangling symlink は拒否する（書込みは symlink の先に作られる）", async () => {
    symlinkSync(
      path.join(profile, "not-yet.json"),
      path.join(documents, "dangling"),
    );
    expect(
      await reason(guard().assertOutside(path.join(documents, "dangling"))),
    ).toBe("unresolvable");
  });

  it("絶対 path でない、`..` を含む、NUL を含む、空の path は拒否する（fail closed）", async () => {
    for (const target of [
      "profile-egress.json",
      "./profile-egress.json",
      `${documents}/../userData/profile-egress.json`,
      `${documents}/a\0b`,
      "",
    ]) {
      expect(await reason(guard().assertOutside(target))).toBe("unresolvable");
    }
  });

  it("profile data directory が解決できないときは何も通さない（fail closed）", async () => {
    const missing = createProfileDataGuard(() => path.join(base, "nope"));
    expect(
      await reason(missing.assertOutside(path.join(documents, "note.md"))),
    ).toBe("unresolvable");
    const throwing = createProfileDataGuard(() => {
      throw new Error("no userData");
    });
    expect(
      await reason(throwing.assertOutside(path.join(documents, "note.md"))),
    ).toBe("unresolvable");
  });

  it("file の下に存在しない名前を付けた path（ENOTDIR）は拒否する", async () => {
    expect(
      await reason(
        guard().assertOutside(path.join(documents, "note.md", "child")),
      ),
    ).toBe("unresolvable");
  });

  it("拒否の理由に path を含めない", async () => {
    const error = await guard()
      .assertOutside(path.join(profile, "profile-egress.json"))
      .catch((e: Error) => e);
    expect((error as Error).message).not.toContain(base);
    expect((error as Error).message).not.toContain("profile-egress");
  });

  it("hard link は file の identity ではなく置き場所で見る（残余: renderer は hard link を作れない）", async () => {
    linkSync(
      path.join(profile, "profile-egress.json"),
      path.join(documents, "hard"),
    );
    // 置き場所は外。renderer が hard link を作る経路はない（記録のための固定）。
    await expect(
      guard().assertOutside(path.join(documents, "hard")),
    ).resolves.toBeUndefined();
  });
});

describe("assertNoOverlap", () => {
  const guard = () => createProfileDataGuard(() => profile);

  it("重ならない root は通る", async () => {
    await expect(guard().assertNoOverlap(documents)).resolves.toBeUndefined();
  });

  it("等しい、含まれる、含む root は拒否する", async () => {
    for (const root of [
      profile,
      path.join(profile, "bin"),
      base,
      os.tmpdir() === base ? documents : path.dirname(base),
    ]) {
      expect(await reason(guard().assertNoOverlap(root))).toBe(
        "overlaps-profile-data-directory",
      );
    }
  });

  it("symlink 経由の root も実体で比べる", async () => {
    symlinkSync(profile, path.join(documents, "to-profile"), "dir");
    symlinkSync(base, path.join(documents, "to-base"), "dir");
    for (const root of [
      path.join(documents, "to-profile"),
      path.join(documents, "to-base"),
    ]) {
      expect(await reason(guard().assertNoOverlap(root))).toBe(
        "overlaps-profile-data-directory",
      );
    }
  });
});
