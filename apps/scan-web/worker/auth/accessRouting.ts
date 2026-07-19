/**
 * Only the explicitly listed health, policy, and public-report operations are
 * anonymous. The dispatcher ignores empty path segments, so every other path
 * whose first non-empty segment is `api` fails closed even when the raw URL
 * contains repeated or trailing slashes.
 */
export function routeRequiresAccount(
  method: string,
  pathname: string,
): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "OPTIONS") return false;

  if (normalizedMethod === "GET" && pathname === "/api/v1/health") {
    return false;
  }
  if (
    normalizedMethod === "GET" &&
    /^\/api\/v1\/ai-disclosures\/(?:scan|hosted-editor)$/.test(pathname)
  ) {
    return false;
  }
  if (
    normalizedMethod === "GET" &&
    /^\/api\/v1\/public-reports\/[^/]+$/.test(pathname)
  ) {
    return false;
  }
  if (
    normalizedMethod === "POST" &&
    /^\/api\/v1\/public-reports\/[^/]+\/abuse-reports$/.test(pathname)
  ) {
    return false;
  }

  return pathname.split("/").filter(Boolean)[0] === "api";
}
