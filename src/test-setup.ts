import "@/lib/i18n";
import { vi } from "vitest";

// Mock @tanstack/react-virtual for jsdom (no ResizeObserver / element dimensions)
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

// DOM 系の setup（jest-dom／testing-library／axe の matcher と DOM の polyfill）は
// DOM のある環境（`@vitest-environment happy-dom`／jsdom）の試験にだけ入れる。
// DOM の無い node 環境の試験では使えず、読み込みだけで 1 ファイルあたり数百 ms かかる。
// 環境は setupFiles より前に決まるので、`document` の有無で判定する。
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  const { configure } = await import("@testing-library/react");
  const { expect } = await import("vitest");
  const axeMatchers = await import("vitest-axe/matchers");

  // waitFor/findBy default to 1 s, a host-speed assumption that loaded hosted CI
  // runners exceed; this matches the CI-only vitest timeout relaxation.
  if (process.env.CI) configure({ asyncUtilTimeout: 5_000 });
  // vitest-axe 0.1.0 の extend-expect.js は 0 バイトの no-op のため、matcher を
  // 手動登録する。型拡張 (toHaveNoViolations) は vitest-axe 同梱の d.ts が廃止済の
  // global Vi.Assertion を狙っていて vitest 4 では効かないため、
  // src/test-utils/vitest-axe.d.ts で "vitest" モジュールを直接 augment している。
  expect.extend(axeMatchers);

  // ProseMirror requires DOM APIs that jsdom doesn't implement
  document.elementFromPoint = () => null;
  const emptyDOMRectList = {
    length: 0,
    item: () => null,
    [Symbol.iterator]: Array.prototype[Symbol.iterator],
  } as unknown as DOMRectList;
  Range.prototype.getClientRects = () => emptyDOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLElement.prototype.getClientRects = () => emptyDOMRectList;
}

// happy-dom 21 の Animation.cancel() は finished promise を AbortError で reject するが、
// Web Animations の仕様（cancel の手順で finished promise の [[PromiseIsHandled]] を true にする）
// と違って handled にしない。motion の stop() が cancel() を呼ぶたびに unhandled rejection に
// なるので、仕様どおり handled にする。finished を await する側には reject がそのまま届く。
if (typeof Animation !== "undefined") {
  const cancel = Animation.prototype.cancel;
  Animation.prototype.cancel = function (this: Animation) {
    this.finished.catch(() => {});
    return cancel.call(this);
  };
}
