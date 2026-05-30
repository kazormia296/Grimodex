// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TrashBinPopover } from "./TrashBinPopover";
import { copyWithAttribution } from "@/lib/clipboardAttribution";
import type { TrashItemData, TrashSpan } from "./types";

vi.mock("@/lib/clipboardAttribution", () => ({
  copyWithAttribution: vi.fn(() => Promise.resolve()),
}));

// Popover を素通し div に置換（open 制御や portal を介さず content を描画）。
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("./trashBinStore", () => ({
  useTrashBinStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ removeItem: vi.fn(), pickup: vi.fn() }),
}));

vi.mock("@/store/dropTargetRegistry", () => ({
  useDropTargetRegistry: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ targets: new Map() }),
}));

vi.mock("./pickupHandlers", () => ({
  acceptsMatrix: () => false,
  pickupAndDispatch: vi.fn(),
}));

vi.mock("./ConfirmDialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_k: string, d?: string) => d ?? _k }),
}));

const span = (text: string, source: TrashSpan["source"]): TrashSpan => ({
  text,
  source,
  model: null,
  chatMessageId: null,
  traceId: null,
  timestamp: null,
});

function fragmentItem(spans: TrashSpan[]): TrashItemData {
  return {
    id: "frag-1",
    projectId: "p",
    kind: "text-fragment",
    subKind: "text-fragment",
    originSceneId: null,
    originCodexId: null,
    previewText: "preview",
    previewMeta: null,
    payload: { text: spans.map((s) => s.text).join(""), spans },
    charCount: 4,
    isInteresting: false,
    deletedAt: new Date(2026, 0, 1).toISOString(),
  } as TrashItemData;
}

const clickCopy = () =>
  fireEvent.click(
    screen.getByRole("button", { name: "クリップボードにコピー" }),
  );

describe("TrashBinPopover — text-fragment コピーの source 伝搬", () => {
  beforeEach(() => vi.clearAllMocks());

  it("spans が単一 source (ai) なら 'ai' を伝搬する", () => {
    render(
      <TrashBinPopover
        item={fragmentItem([span("AI", "ai"), span("文", "ai")])}
      >
        <span>trigger</span>
      </TrashBinPopover>,
    );
    clickCopy();
    expect(copyWithAttribution).toHaveBeenCalledWith("AI文", "ai");
  });

  it("spans の source が混在なら 'unknown' を伝搬する", () => {
    render(
      <TrashBinPopover
        item={fragmentItem([span("AI", "ai"), span("人", "human")])}
      >
        <span>trigger</span>
      </TrashBinPopover>,
    );
    clickCopy();
    expect(copyWithAttribution).toHaveBeenCalledWith("AI人", "unknown");
  });

  it("単一 source (human) なら 'human' を伝搬する", () => {
    render(
      <TrashBinPopover item={fragmentItem([span("手書き", "human")])}>
        <span>trigger</span>
      </TrashBinPopover>,
    );
    clickCopy();
    expect(copyWithAttribution).toHaveBeenCalledWith("手書き", "human");
  });
});
