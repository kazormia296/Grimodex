import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import type { ScanEnv } from "../env";
import { AccessAuthError, authenticateScanAccount } from "./accessAuth";

const issuer = "https://grimodex.cloudflareaccess.com";
const audience = "access-audience-tag";

async function signedAccessToken(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  const token = await new SignJWT({
    type: "app",
    sub: "access-subject-123",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return {
    keySet: createLocalJWKSet({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
    token,
  };
}

function accessEnv(overrides: Partial<ScanEnv> = {}): ScanEnv {
  return {
    SCAN_AUTH_MODE: "access",
    SCAN_ENVIRONMENT: "production",
    CF_ACCESS_TEAM_DOMAIN: issuer,
    CF_ACCESS_AUD: audience,
    ...overrides,
  } as unknown as ScanEnv;
}

describe("Cloudflare Access authentication", () => {
  it("verifies the Access JWT and returns only its stable pseudonymous subject", async () => {
    const { keySet, token } = await signedAccessToken();
    const account = await authenticateScanAccount(
      new Request("https://api.grimodex.app/api/v1/session", {
        headers: { "cf-access-jwt-assertion": token },
      }),
      accessEnv(),
      { keySet },
    );

    expect(account).toMatchObject({
      mode: "access",
      subject: "access-subject-123",
    });
    expect(account.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(account).not.toHaveProperty("email");
  });

  it.each([
    ["missing token", undefined, {}],
    ["empty subject", "", { sub: "" }],
    ["service token", "", { sub: "", type: "app" }],
    ["wrong token type", "access-subject-123", { type: "org" }],
  ] as const)("rejects %s", async (_label, _subject, claims) => {
    const { keySet, token } = await signedAccessToken(claims);
    const request = new Request("https://api.grimodex.app/api/v1/scans", {
      method: "POST",
      headers:
        _label === "missing token"
          ? undefined
          : { "cf-access-jwt-assertion": token },
    });

    await expect(
      authenticateScanAccount(request, accessEnv(), { keySet }),
    ).rejects.toMatchObject({
      status: 401,
      code: "account_auth_required",
    } satisfies Partial<AccessAuthError>);
  });

  it("provides a fixed account only for an explicit loopback development mode", async () => {
    await expect(
      authenticateScanAccount(
        new Request("http://127.0.0.1:8787/api/v1/session"),
        accessEnv({
          SCAN_AUTH_MODE: "local",
          SCAN_ENVIRONMENT: "development",
        }),
      ),
    ).resolves.toMatchObject({
      mode: "local",
      subject: "local-development",
    });

    await expect(
      authenticateScanAccount(
        new Request("https://api.grimodex.app/api/v1/session"),
        accessEnv({
          SCAN_AUTH_MODE: "local",
          SCAN_ENVIRONMENT: "production",
        }),
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "account_auth_configuration_invalid",
    });
  });
});
