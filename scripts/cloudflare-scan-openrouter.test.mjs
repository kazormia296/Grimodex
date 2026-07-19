import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parse } from "jsonc-parser";

const root = new URL("../", import.meta.url);

describe("Cloudflare Scan OpenRouter deployment contract", () => {
  it("separates extraction, frontier, and Editor models in production", async () => {
    const config = parse(
      await readFile(
        new URL("apps/scan-web/wrangler.production.jsonc", root),
        "utf8",
      ),
    );

    assert.equal(config.vars.SCAN_AI_PROVIDER, "workers-ai");
    assert.equal(config.vars.SCAN_AI_MODEL, "@cf/zai-org/glm-4.7-flash");
    assert.equal(config.vars.SCAN_FRONTIER_PROVIDER, "openrouter");
    assert.equal(config.vars.SCAN_FRONTIER_MODEL, "openai/gpt-5.6-terra");
    assert.equal(config.vars.SCAN_EDITOR_AI_PROVIDER, "openrouter");
    assert.equal(config.vars.SCAN_EDITOR_AI_MODEL, "openai/gpt-5.6-luna");
    assert.equal(
      config.vars.OPENROUTER_URL,
      "https://openrouter.ai/api/v1/chat/completions",
    );
    assert.equal(config.vars.SCAN_AUTH_MODE, "access");
    assert.match(config.vars.CF_ACCESS_TEAM_DOMAIN, /cloudflareaccess\.com$/u);
    assert.equal(typeof config.vars.CF_ACCESS_AUD, "string");
    assert.ok(config.vars.CF_ACCESS_AUD.length > 0);
    assert.ok(config.secrets.required.includes("OPENROUTER_API_KEY"));
    assert.equal("OPENROUTER_API_KEY" in config.vars, false);
  });

  it("documents deployed and explicit local secret locations without tracking a key", async () => {
    const [docs, gitignore] = await Promise.all([
      readFile(new URL("docs/SCAN_CLOUDFLARE_DEPLOYMENT.md", root), "utf8"),
      readFile(new URL(".gitignore", root), "utf8"),
    ]);

    assert.match(
      docs,
      /wrangler secret put OPENROUTER_API_KEY --config apps\/scan-web\/wrangler\.production\.jsonc/u,
    );
    assert.match(docs, /apps\/scan-web\/\.dev\.vars\.openrouter/u);
    assert.match(docs, /OPENROUTER_API_KEY=sk-or-/u);
    assert.match(gitignore, /\.dev\.vars\.openrouter/u);
  });
});
