import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HORIZONTAL_STRIPE_SIZE,
  OUTER_PAD_PX,
  STRIPE_GAP_PX,
  STRIPE_SIZE,
} from "@/features/layout/layoutConstants";
import {
  EDITOR_STATUS_BAR_ANCHOR,
  STATUS_BAR_GAP_PX,
  PROFILE_EGRESS_STATUS_BOTTOM_PX,
  PROFILE_EGRESS_STATUS_LEFT_PX,
  PHONE_CHAT_COMPOSER_ANCHOR,
  PHONE_COMPOSER_GAP_PX,
  PHONE_NAV_HEIGHT_PX,
  PROFILE_EGRESS_STATUS_PHONE_BOTTOM_PX,
  PROFILE_EGRESS_STATUS_RIGHT_MARGIN_PX,
  PROFILE_EGRESS_STATUS_PHONE_LEFT_PX,
  PROFILE_EGRESS_STATUS_PLACEMENT_CLASS,
  STATUS_MENU_CLEARANCE_PX,
} from "./profileEgressStatusPlacement";

const statusBarSource = readFileSync(
  new URL("../editor/EditorPaneStatusBar.tsx", import.meta.url),
  "utf8",
);
const phoneCss = readFileSync(
  new URL("../layout/adaptive/phoneWorkspace.css", import.meta.url),
  "utf8",
);

describe("profile egress status placement", () => {
  it("falls back to clearing the left stripe column and the bottom stripe row", () => {
    expect(PROFILE_EGRESS_STATUS_LEFT_PX).toBe(
      OUTER_PAD_PX + STRIPE_SIZE + STRIPE_GAP_PX,
    );
    expect(PROFILE_EGRESS_STATUS_BOTTOM_PX).toBe(
      OUTER_PAD_PX + HORIZONTAL_STRIPE_SIZE + STRIPE_GAP_PX,
    );
  });

  it("starts right of the status menu (12 px padding, 120 px wide) with a gap", () => {
    expect(STATUS_MENU_CLEARANCE_PX).toBeGreaterThan(12 + 120);
  });

  it("keeps the literal Tailwind classes in step with the numbers", () => {
    const cls = PROFILE_EGRESS_STATUS_PLACEMENT_CLASS.split(" ");
    // The anchor() fallback plus the offset is the fallback placement.
    expect(cls).toContain(
      `left-[calc(anchor(${EDITOR_STATUS_BAR_ANCHOR}_left,${PROFILE_EGRESS_STATUS_LEFT_PX - STATUS_MENU_CLEARANCE_PX}px)+${STATUS_MENU_CLEARANCE_PX}px)]`,
    );
    expect(cls).toContain(
      `bottom-[calc(anchor(${EDITOR_STATUS_BAR_ANCHOR}_top,${PROFILE_EGRESS_STATUS_BOTTOM_PX - STATUS_BAR_GAP_PX}px)+${STATUS_BAR_GAP_PX}px)]`,
    );
    expect(cls).toContain(
      `max-w-[calc(100vw-${PROFILE_EGRESS_STATUS_LEFT_PX + PROFILE_EGRESS_STATUS_RIGHT_MARGIN_PX}px)]`,
    );
    expect(cls).toContain(
      `max-[719.98px]:max-w-[calc(100vw-${PROFILE_EGRESS_STATUS_PHONE_LEFT_PX + PROFILE_EGRESS_STATUS_RIGHT_MARGIN_PX}px)]`,
    );
    expect(cls).toContain(
      `max-[719.98px]:left-[${PROFILE_EGRESS_STATUS_PHONE_LEFT_PX}px]`,
    );
    expect(cls).toContain(
      `max-[719.98px]:bottom-[calc(anchor(${PHONE_CHAT_COMPOSER_ANCHOR}_top,calc(${PHONE_NAV_HEIGHT_PX}px+env(safe-area-inset-bottom)))+${PHONE_COMPOSER_GAP_PX}px)]`,
    );
  });

  it("names the anchor the editor status bar sets", () => {
    expect(statusBarSource).toContain(
      `[anchor-name:${EDITOR_STATUS_BAR_ANCHOR}]`,
    );
  });

  it("anchors to the visible AI composer (DR-PUBG-35-1)", () => {
    expect(PHONE_NAV_HEIGHT_PX + PHONE_COMPOSER_GAP_PX).toBe(
      PROFILE_EGRESS_STATUS_PHONE_BOTTOM_PX,
    );
    expect(phoneCss).toMatch(
      new RegExp(
        String.raw`\[data-mobile-surface\]:not\(\[inert\]\) \[data-phone-chat-composer\] \{\s*anchor-name: ${PHONE_CHAT_COMPOSER_ANCHOR};`,
      ),
    );
    expect(
      readFileSync(
        new URL(
          "../layout/adaptive/mobile/PhoneChatSurface.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
    ).toContain("data-phone-chat-composer");
  });

  it("sits above the phone workspace nav (68 px plus the safe area)", () => {
    const nav = /--phone-workspace-nav-height:\s*(\d+)px/.exec(phoneCss);
    expect(nav).not.toBeNull();
    expect(PROFILE_EGRESS_STATUS_PHONE_BOTTOM_PX).toBeGreaterThan(
      Number(nav![1]),
    );
    expect(PHONE_NAV_HEIGHT_PX).toBe(Number(nav![1]));
  });
});
