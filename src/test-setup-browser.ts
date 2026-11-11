import "@testing-library/jest-dom/vitest";
import { ensureLocale } from "@/lib/i18n";
// Layout/CSS-dependent tests (e.g. layoutInvariants.browser.test.tsx) need
// Tailwind + CSS variables loaded. The editor browser tests don't depend on
// CSS so they were happy without it; importing globally is harmless for them.
import "@/index.css";
import { vi } from "vitest";

// 製品は英語の辞書を後から読む。試験は言語を直接切り替えるので先に入れておく。
await ensureLocale("en");

// Real browser has ResizeObserver, but we still stub virtualizer
// to avoid layout-dependent behavior in component tests.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
    const size = opts.estimateSize();
    const items = Array.from({ length: opts.count }, (_, i) => ({
      index: i,
      start: i * size,
      size,
      key: i,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * size,
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
    };
  },
}));

// NOTE: Range/DOMRect stubs from test-setup.ts are intentionally omitted.
// Real Chromium returns actual geometry — that's the point of browser mode.
