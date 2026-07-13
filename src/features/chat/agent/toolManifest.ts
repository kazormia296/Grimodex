import manifest from "../../../../agent-tool-manifest.json";

export type ToolCapability = "read" | "write" | "destructive";

export interface AgentToolManifestEntry {
  name: string;
  capability: ToolCapability;
  requiredPolicy: string | null;
  allowedChannels: readonly string[];
  requiresUserConfirmation: boolean;
}

/** Single source of truth shared with the Rust AI parser through build.rs. */
export const AGENT_TOOL_MANIFEST: readonly AgentToolManifestEntry[] =
  manifest.tools as unknown as readonly AgentToolManifestEntry[];

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
