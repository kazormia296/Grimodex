import {
  useCurrentProject,
  useProjectStore,
} from "@/features/project/projectStore";
import { isAiFeatureBlockedByPolicy } from "@/features/ai-policy/policyGuard";
import {
  deriveAiGate,
  evaluateAiCapability,
} from "@/features/ai-policy/evaluateAiCapability";
import { parseAiPolicy } from "@/features/ai-policy/parse";
import type { AiFeature } from "@/features/ai-policy/types";
import type { Nir1LocalPurpose } from "./nir1LocalGenerationApi";

/**
 * The AI usage policy as the NIR-1 local route shows it (DD-1c, DR-DD1C-8;
 * K5/3 "AI 使用ポリシー"; DR-DD1B-12).
 *
 * Writing needs `chat` and `bodyWrite`, Review needs `chat` and `analysis`.
 * The items are read with the existing `evaluateAiCapability`／`deriveAiGate`
 * (a turned-off item hides the control). Because the renderer's
 * `parseAiPolicy` turns an unreadable value into full, a copy of Native's
 * `decide` (`grimodex-core/src/nir1_local_send_policy.rs`) tells an
 * unreadable value apart: the control is disabled with
 * `NIR1_LOCAL_POLICY_UNREADABLE`. The copy only shapes the display and the
 * refusal before IPC; Native's `check_before_attempt` decides.
 */

export const NIR1_LOCAL_PURPOSE_ITEMS: Readonly<
  Record<Nir1LocalPurpose, readonly [AiFeature, AiFeature]>
> = {
  writing: ["chat", "bodyWrite"],
  review: ["chat", "analysis"],
};

export type Nir1LocalPolicyDenialCode =
  | "too-large"
  | "blank"
  | "not-json"
  | "not-object"
  | "preset-invalid"
  | "toggles-not-object"
  | "toggle-missing"
  | "toggle-not-boolean"
  | "item-disabled";

export type Nir1LocalPolicyDecision =
  | { readonly allow: true; readonly source: "default-unset" | "stored" }
  | {
      readonly allow: false;
      readonly code: Nir1LocalPolicyDenialCode;
      readonly item?: string;
    };

/** Native's `NIR1_LOCAL_SEND_POLICY_MAX_BYTES`. */
const MAX_BYTES = 64 * 1024;
const REQUIRED_TOGGLES = ["chat", "bodyWrite", "analysis"] as const;
const VALID_PRESETS = ["full", "assist-off", "review-only", "off", "custom"];
/** Rust's `char::is_whitespace` (the Unicode White_Space property). */
const RUST_WHITESPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function isRustBlank(raw: string): boolean {
  for (const char of raw) {
    if (!RUST_WHITESPACE.has(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/** serde_json's recursion limit: the 128th nested array／object fails. */
const SERDE_MAX_DEPTH = 128;

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * Whether serde_json would refuse a value `JSON.parse` read: a number out of
 * the f64 range (JS reads it as infinite), an escaped lone surrogate in a
 * string or a key, or nesting at the recursion limit (DR-DD1C-21). The walk
 * stops at the limit, so it stays bounded.
 */
function refusedBySerdeJson(value: unknown, depth: number): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (typeof value === "string") return hasLoneSurrogate(value);
  if (value === null || typeof value !== "object") return false;
  if (depth >= SERDE_MAX_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => refusedBySerdeJson(entry, depth + 1));
  }
  return Object.entries(value).some(
    ([key, entry]) =>
      hasLoneSurrogate(key) || refusedBySerdeJson(entry, depth + 1),
  );
}

/** A copy of Native's `decide` (the decision vectors pin the two together). */
export function decideNir1LocalSendPolicy(
  raw: string | null,
  purpose: Nir1LocalPurpose,
): Nir1LocalPolicyDecision {
  if (raw === null) return { allow: true, source: "default-unset" };
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
    return { allow: false, code: "too-large" };
  }
  if (isRustBlank(raw)) return { allow: false, code: "blank" };
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return { allow: false, code: "not-json" };
  }
  if (refusedBySerdeJson(root, 1)) return { allow: false, code: "not-json" };
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return { allow: false, code: "not-object" };
  }
  const { preset, toggles } = root as Record<string, unknown>;
  if (typeof preset !== "string" || !VALID_PRESETS.includes(preset)) {
    return { allow: false, code: "preset-invalid" };
  }
  if (
    toggles === null ||
    typeof toggles !== "object" ||
    Array.isArray(toggles)
  ) {
    return { allow: false, code: "toggles-not-object" };
  }
  const values: Record<string, boolean> = {};
  for (const name of REQUIRED_TOGGLES) {
    if (!Object.hasOwn(toggles, name)) {
      return { allow: false, code: "toggle-missing", item: name };
    }
    const value = (toggles as Record<string, unknown>)[name];
    if (typeof value !== "boolean") {
      return { allow: false, code: "toggle-not-boolean", item: name };
    }
    values[name] = value;
  }
  for (const name of NIR1_LOCAL_PURPOSE_ITEMS[purpose]) {
    if (!values[name])
      return { allow: false, code: "item-disabled", item: name };
  }
  return { allow: true, source: "stored" };
}

export type Nir1LocalPurposeGate =
  | { readonly presentation: "pending" }
  | { readonly presentation: "enabled" }
  | {
      readonly presentation: "hidden";
      readonly reason: "NIR1_LOCAL_POLICY_DENIED";
    }
  | {
      readonly presentation: "disabled";
      readonly reason: "NIR1_LOCAL_POLICY_UNREADABLE";
    };

/** How the start of `purpose` is shown for a project's stored policy. */
export function nir1LocalPurposeGate(
  project: { readonly aiPolicy?: string | null } | null | undefined,
  purpose: Nir1LocalPurpose,
): Nir1LocalPurposeGate {
  if (!project) return { presentation: "pending" };
  const raw = project.aiPolicy ?? null;
  const strict = decideNir1LocalSendPolicy(raw, purpose);
  if (!strict.allow && strict.code !== "item-disabled") {
    return {
      presentation: "disabled",
      reason: "NIR1_LOCAL_POLICY_UNREADABLE",
    };
  }
  const policy = parseAiPolicy(raw);
  for (const item of NIR1_LOCAL_PURPOSE_ITEMS[purpose]) {
    const gate = deriveAiGate(evaluateAiCapability(policy, "ready", item));
    if (gate.presentation === "hidden") {
      return { presentation: "hidden", reason: "NIR1_LOCAL_POLICY_DENIED" };
    }
  }
  return { presentation: "enabled" };
}

/** The gate of `purpose` for the current project. */
export function useNir1LocalPurposeGate(
  purpose: Nir1LocalPurpose,
): Nir1LocalPurposeGate {
  return nir1LocalPurposeGate(useCurrentProject(), purpose);
}

/**
 * The gate of `purpose` for the current project when an accepted send is
 * about to start a generation: the display's gate plus the same defense layer
 * as `blockIfPolicyOff` (`isAiFeatureBlockedByPolicy` on the purpose's items),
 * read at that moment rather than at the last render.
 *
 * Reaching `policyGuard` also keeps its startup chunk whole: a lazy chunk that
 * reaches only `evaluateAiCapability` splits it (+393 bytes measured; the
 * pattern of DR-DA2B-R8).
 */
export function currentNir1LocalPurposeGate(
  purpose: Nir1LocalPurpose,
): Nir1LocalPurposeGate {
  const state = useProjectStore.getState();
  const project = state.projects.find(
    (candidate) => candidate.id === state.currentProjectId,
  );
  const gate = nir1LocalPurposeGate(project, purpose);
  if (
    gate.presentation === "enabled" &&
    NIR1_LOCAL_PURPOSE_ITEMS[purpose].some(isAiFeatureBlockedByPolicy)
  ) {
    return { presentation: "hidden", reason: "NIR1_LOCAL_POLICY_DENIED" };
  }
  return gate;
}
