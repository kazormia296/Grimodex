/**
 * PUB-G の前提 #35（DR-PUBG-35-1）：toast の置き場所を実 Chromium で測る。
 * phone（< 720）は、実 `PhoneWorkspaceChrome`（header・nav）、実 `PhoneChatSurface` の
 * composer、restricted の pill（`ProfileEgressStatusIndicator`）と実 `AppToaster` を置き、
 * toast が nav・composer・pill・header のどれとも交わらないこと、pill が composer の上に
 * 載ること（DR-PUBG-32-1 の未検証）を測る。wide／compact は今までどおり右下。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { page, userEvent } from "vitest/browser";
import { toast } from "sonner";
import i18n from "@/lib/i18n";
import { AppToaster } from "./AppToaster";
import { PhoneWorkspaceChrome } from "@/features/layout/adaptive/PhoneWorkspaceChrome";
import { PhoneChatSurface } from "@/features/layout/adaptive/mobile/PhoneChatSurface";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { PROFILE_EGRESS_UNAVAILABLE_REASONS } from "@/../electron/shared/profileEgressStatusWire";
import type { ProfileEgressStatusView } from "@/lib/profileEgressStatus";
import ProfileEgressStatusIndicator from "@/features/profile-egress/ProfileEgressStatusIndicator";
import { PROFILE_EGRESS_AI_STOP_TRANSLATIONS } from "@/features/profile-egress/profileEgressAiStopText";

const { egressView } = vi.hoisted(() => ({
  egressView: { current: { state: "restricted" } as ProfileEgressStatusView },
}));
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: async () => egressView.current,
  onProfileEgressStatus: () => () => undefined,
  requestProfileActivation: async () => ({ status: "not-activated" }),
}));

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
function rectOf(el: Element | null, name: string): Box {
  expect(el, `${name} is in the DOM`).not.toBeNull();
  const r = el!.getBoundingClientRect();
  expect(r.width, `${name} has a width`).toBeGreaterThan(0);
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}
const intersects = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const PHONE_VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 600, height: 700 }, // sonner's own mobile layout ends here
  { width: 601, height: 700 },
  { width: 719, height: 700 },
];
const LONG_EN = PROFILE_EGRESS_AI_STOP_TRANSLATIONS.en.stopped;
const LONG_JA = PROFILE_EGRESS_AI_STOP_TRANSLATIONS.ja.stopped;

function Phone({
  width,
  height,
  composerActive = true,
}: {
  width: number;
  height: number;
  composerActive?: boolean;
}) {
  return (
    <div
      data-adaptive-workspace-shell
      data-profile="phone"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        display: "flex",
        width,
        height,
      }}
    >
      <PhoneWorkspaceChrome active />
      <div data-workspace-surface-root data-profile="phone">
        <div
          data-mobile-surface
          data-mobile-surface-id="ai"
          {...(composerActive
            ? {}
            : { inert: true, style: { visibility: "hidden" } })}
        >
          <PhoneChatSurface
            messages={[{ id: "m1", role: "user", text: "hello" }]}
            onSend={() => {}}
            disabledHint="AI is not configured"
          />
        </div>
      </div>
    </div>
  );
}

async function settle() {
  await act(async () => {});
  await new Promise((r) => setTimeout(r, 650));
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  egressView.current = { state: "restricted" };
  useCompactNavigationStore.setState({
    activeSurface: "ai",
    backStack: [],
    sheet: null,
  });
});
afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe("toast placement on the phone workspace (real Chromium)", () => {
  for (const vp of PHONE_VIEWPORTS) {
    it(`keeps toasts clear of the header, the nav, the composer and the pill at ${vp.width}x${vp.height}`, async () => {
      await page.viewport(vp.width, vp.height);
      render(
        <>
          <Phone {...vp} />
          <ProfileEgressStatusIndicator />
          <AppToaster />
        </>,
      );
      await screen.findByTestId("profile-egress-status");
      act(() => {
        toast.error(LONG_EN, { duration: Infinity });
        toast.error(LONG_JA, { duration: Infinity });
        toast.error("short", { duration: Infinity });
      });
      await settle();
      const header = rectOf(
        document.querySelector(".phone-workspace-chrome__header"),
        "header",
      );
      const nav = rectOf(
        document.querySelector(".phone-workspace-chrome__nav"),
        "nav",
      );
      const composer = rectOf(
        document.querySelector("[data-phone-chat-composer]"),
        "composer",
      );
      const pill = rectOf(screen.getByTestId("profile-egress-status"), "pill");
      const toasts = [...document.querySelectorAll("[data-sonner-toast]")];
      expect(toasts.length).toBe(3);
      // Collapsed, then expanded (the pointer over the stack).
      for (const expanded of [false, true]) {
        if (expanded) {
          await userEvent.hover(toasts[0]!);
          await new Promise((r) => setTimeout(r, 500));
        }
        toasts.forEach((el, index) => {
          const t = rectOf(el, `toast ${index}`);
          const label = `toast ${index} (${expanded ? "expanded" : "collapsed"})`;
          expect(t.left, `${label} is on screen`).toBeGreaterThanOrEqual(0);
          expect(t.right, `${label} is on screen`).toBeLessThanOrEqual(
            vp.width,
          );
          expect(
            t.top,
            `${label} starts under the header`,
          ).toBeGreaterThanOrEqual(header.bottom);
          expect(intersects(t, nav), `${label} overlaps the nav`).toBe(false);
          expect(
            intersects(t, composer),
            `${label} overlaps the composer`,
          ).toBe(false);
          expect(intersects(t, pill), `${label} overlaps the pill`).toBe(false);
        });
      }
    });
  }

  it("lifts the pill above the composer (DR-PUBG-32-1 left this unmeasured)", async () => {
    const views: ProfileEgressStatusView[] = [
      { state: "restricted" },
      { state: "activating" },
      ...PROFILE_EGRESS_UNAVAILABLE_REASONS.map(
        (reason): ProfileEgressStatusView => ({ state: "unavailable", reason }),
      ),
    ];
    for (const vp of PHONE_VIEWPORTS) {
      await page.viewport(vp.width, vp.height);
      for (const next of views) {
        egressView.current = next;
        const { unmount } = render(
          <>
            <Phone {...vp} />
            <ProfileEgressStatusIndicator />
          </>,
        );
        const display = await screen.findByTestId("profile-egress-status");
        await act(async () => {});
        const composer = rectOf(
          document.querySelector("[data-phone-chat-composer]"),
          "composer",
        );
        const nav = rectOf(
          document.querySelector(".phone-workspace-chrome__nav"),
          "nav",
        );
        const d = rectOf(display, "pill");
        const label = `${JSON.stringify(next)} at ${vp.width}x${vp.height}`;
        expect(
          intersects(d, composer),
          `${label}: pill overlaps composer`,
        ).toBe(false);
        expect(d.bottom, `${label}: 8 px above the composer`).toBeCloseTo(
          composer.top - 8,
          0,
        );
        expect(d.bottom).toBeLessThanOrEqual(nav.top);
        expect(d.left).toBeCloseTo(12, 0);
        expect(d.top).toBeGreaterThan(0);
        unmount();
      }
    }
  });

  it("keeps the pill 8 px above the nav when the composer is not showing", async () => {
    const vp = { width: 360, height: 640 };
    await page.viewport(vp.width, vp.height);
    render(
      <>
        <Phone {...vp} composerActive={false} />
        <ProfileEgressStatusIndicator />
      </>,
    );
    const display = await screen.findByTestId("profile-egress-status");
    await act(async () => {});
    const nav = rectOf(
      document.querySelector(".phone-workspace-chrome__nav"),
      "nav",
    );
    // A mounted but hidden (inert) AI surface is no anchor.
    expect(rectOf(display, "pill").bottom).toBeCloseTo(nav.top - 8, 0);
  });

  it("moves a toast that is on screen when the window crosses the breakpoint", async () => {
    await page.viewport(1200, 800);
    render(<AppToaster />);
    act(() => {
      toast.error("crossing", { duration: Infinity });
    });
    await settle();
    const wide = rectOf(document.querySelector("[data-sonner-toast]"), "wide");
    expect(wide.bottom).toBeGreaterThan(700);
    await page.viewport(360, 640);
    await settle();
    const phone = rectOf(
      document.querySelector("[data-sonner-toast]"),
      "phone",
    );
    expect(phone.top).toBeLessThan(120);
  });
});

describe("toast placement elsewhere is unchanged (real Chromium)", () => {
  for (const vp of [
    { width: 720, height: 700 },
    { width: 1100, height: 800 },
    { width: 1200, height: 800 },
  ]) {
    it(`stays in the bottom-right corner at ${vp.width}x${vp.height}`, async () => {
      await page.viewport(vp.width, vp.height);
      render(<AppToaster />);
      act(() => {
        toast.error("corner", { duration: Infinity });
      });
      await settle();
      const t = rectOf(document.querySelector("[data-sonner-toast]"), "toast");
      // sonner's default: 24 px from the right and bottom edges, 356 px wide.
      expect(t.right).toBeCloseTo(vp.width - 24, 0);
      expect(t.bottom).toBeCloseTo(vp.height - 24, 0);
      expect(t.right - t.left).toBeCloseTo(356, 0);
    });
  }
});
