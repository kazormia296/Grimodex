import {
  classifyAiPolicy,
  type AiPolicyClassification,
} from "../../../electron/shared/aiPolicy/classifyAiPolicy";
import type { AiPolicy } from "./types";

export function getAiPolicyClassification(
  raw: string | null | undefined,
): AiPolicyClassification {
  return classifyAiPolicy(raw);
}

export function parseAiPolicy(raw: string | null | undefined): AiPolicy {
  const { preset, toggles } = getAiPolicyClassification(raw);
  return { preset, toggles };
}

export function serializeAiPolicy(policy: AiPolicy): string {
  return JSON.stringify(policy);
}

/** `null` is the explicit missing state; unreadable and absent values stop body writes. */
export function isBodyWriteDisabled(raw: string | null | undefined): boolean {
  return !parseAiPolicy(raw).toggles.bodyWrite;
}
