/**
 * Native の migration は、別 process（常駐する MCP client など）が共有 lease を
 * 握っていると 10 秒待って `WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT` で失敗する。
 * 英語の生メッセージだけでは原因と対処が分からないので、案内を後ろに足す。
 */
export const WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT_MARKER =
  "WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT";

export function workspaceOpenErrorText(
  error: string,
  t: (key: string) => string,
): string {
  if (!error.includes(WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT_MARKER)) return error;
  return `${error} ${t("workspace.leaseTimeoutHint")}`;
}
