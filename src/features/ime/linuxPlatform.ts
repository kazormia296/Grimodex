/** Linux detection kept local to the optional IME installation guidance. */
export function isLinuxImeHost(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  return /linux/i.test(platform);
}
