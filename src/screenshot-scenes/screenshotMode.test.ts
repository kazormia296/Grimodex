/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCREENSHOT_LANGUAGE,
  SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY,
  SCREENSHOT_MODE_LOCALSTORAGE_KEY,
  getScreenshotLanguage,
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

describe("getScreenshotLanguage", () => {
  afterEach(() => {
    localStorage.removeItem(SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY);
  });

  it("defaults to ja when the flag is absent", () => {
    expect(getScreenshotLanguage()).toBe("ja");
    expect(DEFAULT_SCREENSHOT_LANGUAGE).toBe("ja");
  });

  it("returns en when grimodex:screenshot-language is en", () => {
    localStorage.setItem(SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY, "en");
    expect(getScreenshotLanguage()).toBe("en");
  });

  it("falls back to ja for unsupported values", () => {
    localStorage.setItem(SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY, "fr");
    expect(getScreenshotLanguage()).toBe("ja");
  });
});
