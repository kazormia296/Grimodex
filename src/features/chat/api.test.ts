import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

import {
  getAiSettings,
  saveAiSettings,
  saveApiKey,
  getApiKey,
  deleteApiKey,
  testAiConnection,
  listAiModels,
} from "./api";
import type { AiSettings } from "./types";

describe("chat/api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getAiSettings", () => {
    it("invokes get_ai_settings command", async () => {
      const settings = {
        provider: "openrouter",
        model: "gpt-4",
        ollamaEndpoint: "http://localhost:11434",
      };
      mockInvoke.mockResolvedValueOnce(settings);

      const result = await getAiSettings();
      expect(mockInvoke).toHaveBeenCalledWith("get_ai_settings");
      expect(result).toEqual(settings);
    });
  });

  describe("saveAiSettings", () => {
    it("invokes save_ai_settings with settings payload", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      const settings: AiSettings = {
        provider: "openai",
        model: "gpt-4o",
        ollamaEndpoint: "http://localhost:11434",
        thinkingEnabled: true,
      };

      await saveAiSettings(settings);
      expect(mockInvoke).toHaveBeenCalledWith("save_ai_settings", {
        settings,
      });
    });
  });

  describe("saveApiKey", () => {
    it("invokes save_api_key with provider and key", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await saveApiKey("openrouter", "sk-or-test-123");
      expect(mockInvoke).toHaveBeenCalledWith("save_api_key", {
        provider: "openrouter",
        key: "sk-or-test-123",
      });
    });
  });

  describe("getApiKey", () => {
    it("returns the key when it exists", async () => {
      mockInvoke.mockResolvedValueOnce("sk-or-test-123");

      const result = await getApiKey("openrouter");
      expect(mockInvoke).toHaveBeenCalledWith("get_api_key", {
        provider: "openrouter",
      });
      expect(result).toBe("sk-or-test-123");
    });

    it("returns null when no key exists", async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const result = await getApiKey("openai");
      expect(result).toBeNull();
    });
  });

  describe("deleteApiKey", () => {
    it("invokes delete_api_key with provider", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await deleteApiKey("anthropic");
      expect(mockInvoke).toHaveBeenCalledWith("delete_api_key", {
        provider: "anthropic",
      });
    });
  });

  describe("testAiConnection", () => {
    it("invokes test_ai_connection and returns result", async () => {
      mockInvoke.mockResolvedValueOnce("Hello! Connection successful.");

      const result = await testAiConnection("openrouter", "gpt-4");
      expect(mockInvoke).toHaveBeenCalledWith("test_ai_connection", {
        provider: "openrouter",
        model: "gpt-4",
      });
      expect(result).toBe("Hello! Connection successful.");
    });

    it("propagates error on failure", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("Invalid API key"));

      await expect(testAiConnection("openrouter", "gpt-4")).rejects.toThrow(
        "Invalid API key",
      );
    });
  });

  describe("listAiModels", () => {
    it("invokes list_ai_models and returns model list", async () => {
      const models = [
        { id: "gpt-4", name: "GPT-4" },
        { id: "claude-3", name: "Claude 3" },
      ];
      mockInvoke.mockResolvedValueOnce(models);

      const result = await listAiModels("openrouter");
      expect(mockInvoke).toHaveBeenCalledWith("list_ai_models", {
        provider: "openrouter",
      });
      expect(result).toEqual(models);
    });
  });
});
