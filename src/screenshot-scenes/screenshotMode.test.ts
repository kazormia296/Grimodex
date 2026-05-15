/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  SCREENSHOT_MODE_LOCALSTORAGE_KEY,
  isScreenshotStagingActive,
} from "./screenshotMode";

describe("isScreenshotStagingActive", () => {
  afterEach(() => {
    localStorage.removeItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY);
  });

  it("is false when the flag is absent", () => {
    expect(isScreenshotStagingActive()).toBe(false);
  });

  it("is true when grimodex:screenshot-mode is true", () => {
    localStorage.setItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY, "true");
    expect(isScreenshotStagingActive()).toBe(true);
  });
});
