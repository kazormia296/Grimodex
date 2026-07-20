/** Opens the settings category that owns project-level AI policy controls. */
export function openAiPolicySettings(): void {
  window.dispatchEvent(
    new CustomEvent("open-settings", { detail: { category: "ai" } }),
  );
}
