import manifest from "../../../../agent-tool-manifest.json";

export type ToolCapability = "read" | "write" | "destructive";
export type ToolEffect = "read" | "ui" | "mutate" | "destructive";
export type ToolApprovalMode = "none" | "each" | "always";
const TOOL_EFFECTS: readonly string[] = ["read", "ui", "mutate", "destructive"];
const TOOL_APPROVAL_MODES: readonly string[] = ["none", "each", "always"];

export interface AgentToolManifestEntry {
  name: string;
  capability: ToolCapability;
  effect: ToolEffect;
  approvalMode: ToolApprovalMode;
  requiredPolicy: string | null;
  allowedChannels: readonly string[];
  requiresUserConfirmation: boolean;
}

export function validateAgentToolManifest(
  tools: readonly AgentToolManifestEntry[],
): void {
  for (const tool of tools) {
    if (
      !TOOL_EFFECTS.includes(tool.effect) ||
      !TOOL_APPROVAL_MODES.includes(tool.approvalMode)
    ) {
      throw new Error(`missing or invalid classification for ${tool.name}`);
    }
    const expectedApprovalMode =
      tool.effect === "mutate"
        ? "each"
        : tool.effect === "destructive"
          ? "always"
          : "none";
    if (tool.approvalMode !== expectedApprovalMode) {
      throw new Error(
        `invalid approvalMode for ${tool.name}: ${tool.effect} requires ${expectedApprovalMode}`,
      );
    }
    if (
      (tool.effect === "read") !== (tool.capability === "read") ||
      (tool.effect === "destructive") !==
        (tool.capability === "destructive")
    ) {
      throw new Error(`effect and capability disagree for ${tool.name}`);
    }
  }
}

/** Single source of truth shared with the Rust AI parser through build.rs. */
export const AGENT_TOOL_MANIFEST =
  manifest.tools as unknown as readonly AgentToolManifestEntry[];
if (import.meta.env.DEV) validateAgentToolManifest(AGENT_TOOL_MANIFEST);

export const MANIFEST_TOOL_NAMES: readonly string[] = Object.freeze(
  AGENT_TOOL_MANIFEST.map((tool) => tool.name),
);

/** Read-capability tools allowed through the Hermes/native low-trust parser. */
export const HERMES_ALLOWED_TOOL_NAMES: readonly string[] = Object.freeze(
  AGENT_TOOL_MANIFEST.filter((tool) => tool.capability === "read").map(
    (tool) => tool.name,
  ),
);

/** Data tools exposed to the nested read-only research sub-agent. */
export const READ_ONLY_TOOL_NAMES: readonly string[] = Object.freeze(
  HERMES_ALLOWED_TOOL_NAMES.filter(
    (name) => name !== "run_research" && name !== "ask_user",
  ),
);

export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(
  AGENT_TOOL_MANIFEST.filter((tool) => tool.capability !== "read").map(
    (tool) => tool.name,
  ),
);
