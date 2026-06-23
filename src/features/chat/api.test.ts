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
  hasApiKey,
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
        openaiCompatible: { baseUrl: "" },
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
        endpointId: null,
      });
    });
  });

  describe("hasApiKey", () => {
    it("returns true when a key exists (without exposing the key)", async () => {
      mockInvoke.mockResolvedValueOnce(true);

      const result = await hasApiKey("openrouter");
      expect(mockInvoke).toHaveBeenCalledWith("has_api_key", {
        provider: "openrouter",
        endpointId: null,
      });
      expect(result).toBe(true);
    });

    it("returns false when no key exists", async () => {
      mockInvoke.mockResolvedValueOnce(false);

      const result = await hasApiKey("openai");
      expect(result).toBe(false);
    });
  });

  describe("deleteApiKey", () => {
    it("invokes delete_api_key with provider", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await deleteApiKey("anthropic");
      expect(mockInvoke).toHaveBeenCalledWith("delete_api_key", {
        provider: "anthropic",
        endpointId: null,
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
        apiVariant: null,
        endpointId: null,
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
        endpointId: null,
      });
      expect(result).toEqual(models);
    });
  });
});
