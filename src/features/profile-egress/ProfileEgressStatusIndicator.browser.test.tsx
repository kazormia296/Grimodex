/**
 * 実 Chromium で動かす外部送信の制限の状態の表示（NIR-1 DA-2 ST3）の幾何
 * invariant テスト。happy-dom は fixed 配置の実寸を計算しないため、狭い窓でも
 * 表示が viewport の内に収まり、横にはみ出さないことを実ブラウザで測る。
 *
 *   B-1 幅 320／360／768／1280 px で、restricted・activating・unavailable
 *       （8 つの理由すべて、ja と en）のどれも viewport の内に収まり、
 *       document に横スクロールを作らない。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import i18n from "@/lib/i18n";
import type { ProfileEgressStatusView } from "@/lib/profileEgressStatus";
import { PROFILE_EGRESS_UNAVAILABLE_REASONS } from "@/../electron/shared/profileEgressStatusWire";

const { view } = vi.hoisted(() => ({
  view: { current: { state: "restricted" } as ProfileEgressStatusView },
}));
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: async () => view.current,
  onProfileEgressStatus: () => () => undefined,
  requestProfileActivation: async () => ({ status: "not-activated" }),
}));

import ProfileEgressStatusIndicator from "./ProfileEgressStatusIndicator";

const WIDTHS = [320, 360, 768, 1280] as const;
const VIEWS: ProfileEgressStatusView[] = [
  { state: "restricted" },
  { state: "activating" },
  ...PROFILE_EGRESS_UNAVAILABLE_REASONS.map(
    (reason): ProfileEgressStatusView => ({ state: "unavailable", reason }),
  ),
];
const EPSILON = 0.75;

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("ja");
});

describe("profile egress status display geometry", () => {
  for (const language of ["ja", "en"] as const) {
    for (const width of WIDTHS) {
      it(`stays inside a ${width}px viewport in ${language}`, async () => {
        await page.viewport(width, 640);
        await i18n.changeLanguage(language);
        for (const next of VIEWS) {
          view.current = next;
          render(<ProfileEgressStatusIndicator />);
          await act(async () => {});
          const element = await screen.findByTestId("profile-egress-status");
          const rect = element.getBoundingClientRect();
          expect(rect.width).toBeGreaterThan(0);
          expect(rect.left).toBeGreaterThanOrEqual(-EPSILON);
          expect(rect.top).toBeGreaterThanOrEqual(-EPSILON);
          expect(rect.right).toBeLessThanOrEqual(window.innerWidth + EPSILON);
          expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + EPSILON);
          expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
            window.innerWidth,
          );
          cleanup();
        }
      });
    }
  }
});
