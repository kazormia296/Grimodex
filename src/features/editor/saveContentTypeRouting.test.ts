import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression guard for commit 1eb206d (Codex/Snippet タブの autosave が
 * scene 経路に misroute する不具合を修正).
 *
 * Contract enforced here:
 * 1. `coreSave` must read `saveContentTypeRef.current`, NOT the closure-captured
 *    `contentType` prop, when branching on the save backend. Reading the prop
 *    directly would misroute scene A's pending edits to the codex/snippet
 *    backend on tab switch within the autosave debounce window.
 *
 * 2. `switchScene` must `await flush()` BEFORE updating
 *    `saveContentTypeRef.current = contentType`, so the flush still routes
 *    the previous tab's pending edits to the correct backend.
 *
 * This is a pinning test against the source code. A behavioral test would
 * require mounting the full EditorPane (1900+ lines, ~100 imports). The
 * pinning shape is sufficient because the bug class is purely about which
 * source-of-truth the routing reads.
 */

const FILE = resolve(__dirname, "EditorPane.tsx");

describe("saveContentTypeRef routing contract", () => {
  const source = readFileSync(FILE, "utf8");

  it("declares saveContentTypeRef as a useRef", () => {
    expect(source).toMatch(/saveContentTypeRef = useRef<TabContentType>/);
  });

  it("coreSave branches on saveContentTypeRef.current — not the prop", () => {
    // Locate coreSave's body. We accept either a useCallback or function
    // declaration to keep the test from breaking on cosmetic refactors.
    const coreSaveStart = source.indexOf("const coreSave = useCallback");
    expect(coreSaveStart).toBeGreaterThan(-1);

    // Bound the search to a generous window so an unrelated downstream
    // `contentType ===` comparison can't satisfy the assertion.
    const window = source.slice(coreSaveStart, coreSaveStart + 2000);

    // Must read from the ref at least once for routing.
    expect(window).toMatch(/saveContentTypeRef\.current/);

    // Must NOT branch on the prop directly inside coreSave. Pattern catches
    // `contentType === "codex"` and `contentType === "snippet"` style checks
    // — i.e. the original misroute shape.
    expect(window).not.toMatch(/\bcontentType === ["']codex["']/);
    expect(window).not.toMatch(/\bcontentType === ["']snippet["']/);
  });

  it("switchScene flushes BEFORE updating saveContentTypeRef.current", () => {
    const switchSceneStart = source.indexOf("async function switchScene");
    expect(switchSceneStart).toBeGreaterThan(-1);

    const window = source.slice(switchSceneStart, switchSceneStart + 3000);

    const refUpdateIdx = window.indexOf("saveContentTypeRef.current =");
    expect(refUpdateIdx).toBeGreaterThan(-1);

    // There must be at least one `await flush()` *before* the ref update in
    // switchScene. The flush routes via the OLD ref value, so updating
    // beforehand would misroute the previous tab's pending edits.
    const before = window.slice(0, refUpdateIdx);
    expect(before).toMatch(/await flush\(\)/);
  });
});
