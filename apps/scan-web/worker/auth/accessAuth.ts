import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { ScanEnv } from "../env";

const LOCAL_ACCOUNT_SUBJECT = "local-development";
const MAX_ACCESS_SUBJECT_LENGTH = 128;
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

export type ScanAccount =
  | {
      mode: "access" | "local";
      subject: string;
      expiresAt: string;
    }
  | {
      mode: "disabled";
      subject: null;
      expiresAt: string;
    };

export class AccessAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AccessAuthError";
  }
}

function normalizedTeamDomain(env: ScanEnv): string {
  const configured = env.CF_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new AccessAuthError(
      503,
      "account_auth_configuration_invalid",
      "Cloudflare Access is not configured",
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".cloudflareaccess.com") ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new AccessAuthError(
      503,
      "account_auth_configuration_invalid",
      "Cloudflare Access is not configured",
    );
  }
  return url.origin;
}

function accessAudience(env: ScanEnv): string {
  const audience = env.CF_ACCESS_AUD?.trim() ?? "";
  if (audience.length < 1 || audience.length > 256) {
    throw new AccessAuthError(
      503,
      "account_auth_configuration_invalid",
      "Cloudflare Access is not configured",
    );
  }
  return audience;
}

function remoteKeySet(teamDomain: string): JWTVerifyGetKey {
  const cached = remoteKeySets.get(teamDomain);
  if (cached) return cached;
  const created = createRemoteJWKSet(
    new URL(`${teamDomain}/cdn-cgi/access/certs`),
  );
  remoteKeySets.set(teamDomain, created);
  return created;
}

function localAccount(request: Request, env: ScanEnv): ScanAccount {
  const hostname = new URL(request.url).hostname;
  if (
    env.SCAN_ENVIRONMENT !== "development" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)
  ) {
    throw new AccessAuthError(
      503,
      "account_auth_configuration_invalid",
      "local account mode is only available on a development loopback host",
    );
  }
  return {
    mode: "local",
    subject: LOCAL_ACCOUNT_SUBJECT,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  };
}

export async function authenticateScanAccount(
  request: Request,
  env: ScanEnv,
  options: { keySet?: JWTVerifyGetKey } = {},
): Promise<ScanAccount> {
  const mode = env.SCAN_AUTH_MODE;
  if (mode === "local") return localAccount(request, env);
  if (mode === "disabled" || mode === undefined) {
    if (env.SCAN_ENVIRONMENT === "production") {
      throw new AccessAuthError(
        503,
        "account_auth_configuration_invalid",
        "account authentication is required in production",
      );
    }
    return {
      mode: "disabled",
      subject: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    };
  }
  if (mode !== "access") {
    throw new AccessAuthError(
      503,
      "account_auth_configuration_invalid",
      "account authentication mode is invalid",
    );
  }

  const teamDomain = normalizedTeamDomain(env);
  const audience = accessAudience(env);
  const token = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!token) {
    throw new AccessAuthError(
      401,
      "account_auth_required",
      "a Cloudflare Access account is required",
    );
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(
      token,
      options.keySet ?? remoteKeySet(teamDomain),
      {
        algorithms: ["RS256"],
        audience,
        issuer: teamDomain,
      },
    ));
  } catch (cause) {
    const invalidSession =
      cause instanceof joseErrors.JOSEAlgNotAllowed ||
      cause instanceof joseErrors.JWKSNoMatchingKey ||
      cause instanceof joseErrors.JWSInvalid ||
      cause instanceof joseErrors.JWSSignatureVerificationFailed ||
      cause instanceof joseErrors.JWTClaimValidationFailed ||
      cause instanceof joseErrors.JWTExpired ||
      cause instanceof joseErrors.JWTInvalid;
    if (!invalidSession) {
      throw new AccessAuthError(
        503,
        "account_auth_unavailable",
        "Cloudflare Access verification is unavailable",
      );
    }
    throw new AccessAuthError(
      401,
      "account_auth_required",
      "the Cloudflare Access session is invalid or expired",
    );
  }

  const subject = payload.sub;
  if (
    payload.type !== "app" ||
    typeof subject !== "string" ||
    subject.length < 1 ||
    subject.length > MAX_ACCESS_SUBJECT_LENGTH ||
    typeof payload.exp !== "number"
  ) {
    throw new AccessAuthError(
      401,
      "account_auth_required",
      "the Cloudflare Access session is not a user session",
    );
  }
  return {
    mode: "access",
    subject,
    expiresAt: new Date(payload.exp * 1_000).toISOString(),
  };
}
