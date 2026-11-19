/**
 * 定期 workflow（.github/workflows/update-model-capabilities.yml）の静的な試験。
 * 仕様の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §3.3（T4・T7・T10）と §7。
 * workflow は実行しない（通信なし）。構造だけを確かめる。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workflowFile = path.join(
  repoRoot,
  ".github",
  "workflows",
  "update-model-capabilities.yml",
);
const text = await readFile(workflowFile, "utf8");
const workflow = load(text);
/** comment を含まない、parse 済みの構造の文字列表現（text の走査は comment に当たるため使わない）。 */
const structured = JSON.stringify(workflow);
const generate = workflow.jobs.generate;
const createPr = workflow.jobs["create-pr"];

const SECRET_NAMES = [
  "MODEL_REGISTRY_APP_CLIENT_ID",
  "MODEL_REGISTRY_APP_PRIVATE_KEY",
];

/** parse 済みの構造の中の全ての文字列（comment は含まれない）。 */
function allStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, result);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value)) allStrings(v, result);
  }
  return result;
}

function collectUses(value, result = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectUses(entry, result);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "uses" && typeof entry === "string") result.push(entry);
      collectUses(entry, result);
    }
  }
  return result;
}

function stepNamed(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `step が無い: ${name}`);
  return step;
}

function runOf(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

function expressionsIn(value) {
  return allStrings(value).flatMap((string) =>
    [...string.matchAll(/\$\{\{\s*([\s\S]*?)\s*\}\}/g)].map((m) => m[1]),
  );
}

describe("update-model-capabilities workflow", () => {
  it("週 1 回の schedule と手動の dispatch だけで起動し、concurrency で重ならない", () => {
    assert.deepEqual(Object.keys(workflow.on).sort(), [
      "schedule",
      "workflow_dispatch",
    ]);
    assert.deepEqual(workflow.on.schedule, [{ cron: "41 3 * * 1" }]);
    assert.equal(workflow.on.workflow_dispatch, null);
    assert.deepEqual(workflow.concurrency, {
      group: "update-model-capabilities",
      "cancel-in-progress": false,
    });
    assert.deepEqual(Object.keys(workflow.jobs), ["generate", "create-pr"]);
  });

  it("GITHUB_TOKEN は全体も各 job も contents: read のまま（write は App の token だけ）", () => {
    assert.deepEqual(workflow.permissions, { contents: "read" });
    assert.deepEqual(generate.permissions, { contents: "read" });
    assert.deepEqual(createPr.permissions, { contents: "read" });
    // 権限の block に write は無い。write が現れるのは App の token の入力（permission-*）だけ。
    assert.doesNotMatch(
      JSON.stringify([
        workflow.permissions,
        generate.permissions,
        createPr.permissions,
      ]),
      /write/,
    );
    assert.doesNotMatch(structured, /GITHUB_TOKEN|github\.token/);
    assert.doesNotMatch(structured, /pull_request|workflow_run|issue_comment/);
    // PR の merge は行わない（auto-merge は使わない。Q9）。
    assert.doesNotMatch(
      structured,
      /auto-merge|--auto\b|gh pr merge|pulls\/.*\/merge/,
    );
  });

  it("secrets は create-pr だけが使い、名前は決めた 2 つに限る", () => {
    assert.doesNotMatch(JSON.stringify(generate), /secrets\./);
    const secretRefs = [...JSON.stringify(createPr).matchAll(/secrets\.(\w+)/g)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual([...new Set(secretRefs)], [...SECRET_NAMES].sort());
    for (const name of allStrings(workflow)
      .join("\n")
      .match(/secrets\.\w+/g) ?? []) {
      assert.ok(
        SECRET_NAMES.includes(name.replace("secrets.", "")),
        `想定外の secret: ${name}`,
      );
    }
  });

  it("App の token は pin した公式の action で、contents と pull-requests の write だけに絞る", () => {
    const step = createPr.steps.find((s) => s.id === "app-token");
    assert.ok(step);
    assert.equal(
      step.uses,
      "actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510",
    );
    assert.deepEqual(step.with, {
      "client-id": "${{ secrets.MODEL_REGISTRY_APP_CLIENT_ID }}",
      "private-key": "${{ secrets.MODEL_REGISTRY_APP_PRIVATE_KEY }}",
      "permission-contents": "write",
      "permission-pull-requests": "write",
    });
    // 発行は secret が設定済みのときだけ。
    assert.match(step.if, /env\.APP_SECRETS_CONFIGURED == 'true'/);
    assert.match(step.if, /steps\.verify\.outputs\.changed == 'true'/);
    // token を使う step は、すべて発行 step より後にある。
    const index = (name) => createPr.steps.findIndex((s) => s.name === name);
    assert.ok(index("Push the fixed branch") > createPr.steps.indexOf(step));
    assert.ok(index("Open or update the PR") > index("Push the fixed branch"));
    // token は「設定済みか」の真偽の job env と、step の env だけ。
    assert.equal(
      createPr.env.APP_SECRETS_CONFIGURED,
      "${{ secrets.MODEL_REGISTRY_APP_CLIENT_ID != '' && secrets.MODEL_REGISTRY_APP_PRIVATE_KEY != '' }}",
    );
  });

  it("secret が未設定なら PR を作らず、summary に出して成功で終わる", () => {
    const skip = stepNamed(
      createPr,
      "Skip PR creation because the GitHub App secrets are not set",
    );
    assert.match(skip.if, /env\.APP_SECRETS_CONFIGURED != 'true'/);
    assert.match(skip.run, /GITHUB_STEP_SUMMARY/);
    assert.match(skip.run, /secret 未設定/);
    assert.doesNotMatch(skip.run, /exit [1-9]/);
    // 検証は secret が無くても実行する（verify に secret の条件が無い）。
    const verify = stepNamed(
      createPr,
      "Re-validate the candidate with the master validation module",
    );
    assert.equal(verify.if, undefined);
    for (const name of ["Push the fixed branch", "Open or update the PR"]) {
      assert.match(
        stepNamed(createPr, name).if,
        /APP_SECRETS_CONFIGURED == 'true'/,
      );
    }
  });

  it("全ての action は commit SHA で固定し、checkout は credential を残さない", () => {
    const uses = collectUses(workflow);
    assert.deepEqual(
      [...new Set(uses.map((entry) => entry.split("@")[0]))].sort(),
      [
        "actions/checkout",
        "actions/create-github-app-token",
        "actions/download-artifact",
        "actions/setup-node",
        "actions/upload-artifact",
      ],
    );
    for (const entry of uses) {
      assert.match(entry, /^[^@]+@[0-9a-f]{40}$/, entry);
    }
    for (const job of [generate, createPr]) {
      const checkouts = job.steps.filter((s) =>
        s.uses?.startsWith("actions/checkout@"),
      );
      assert.equal(checkouts.length, 1);
      assert.equal(checkouts[0].with["persist-credentials"], false);
      const node = job.steps.find((s) =>
        s.uses?.startsWith("actions/setup-node@"),
      );
      assert.equal(node.with["node-version"], 22);
    }
    // PR 作成 job は master の版を使う。
    assert.equal(
      createPr.steps.find((s) => s.uses?.startsWith("actions/checkout@")).with
        .ref,
      "master",
    );
  });

  it("依存の install をしない（pnpm／npm／yarn／cargo／pip を呼ばない）", () => {
    const commands = runOf(generate) + "\n" + runOf(createPr);
    assert.doesNotMatch(commands, /\b(pnpm|npm|npx|yarn|cargo|pip)\b/);
    assert.doesNotMatch(structured, /pnpm\/action-setup/);
    // node が実行するのは repo の生成 script だけ（artifact の中の file は実行しない）。
    const nodeCalls = [...commands.matchAll(/\bnode\s+(\S+)/g)].map(
      (m) => m[1],
    );
    assert.ok(nodeCalls.length > 0);
    for (const target of nodeCalls) {
      assert.equal(target, "scripts/generate-model-capability-snapshot.mjs");
    }
  });

  it("run の中に ${{ }} を置かず、式は allowlist だけにする（upstream の値を展開しない）", () => {
    for (const job of [generate, createPr]) {
      for (const step of job.steps) {
        if (typeof step.run === "string") {
          assert.doesNotMatch(step.run, /\$\{\{/, step.name);
        }
      }
    }
    const allowed = new Set([
      "github.repository == 'kazormia296/Grimodex'",
      "steps.compare.outputs.changed",
      "steps.compare.outputs.changed == 'true'",
      "needs.generate.outputs.changed == 'true' && github.repository == 'kazormia296/Grimodex' && github.ref == 'refs/heads/master'",
      "secrets.MODEL_REGISTRY_APP_CLIENT_ID != '' && secrets.MODEL_REGISTRY_APP_PRIVATE_KEY != ''",
      "secrets.MODEL_REGISTRY_APP_CLIENT_ID",
      "secrets.MODEL_REGISTRY_APP_PRIVATE_KEY",
      "github.run_id",
      "runner.temp",
      "github.repository",
      "steps.app-token.outputs.token",
      "steps.verify.outputs.draft",
      "steps.verify.outputs.changed == 'true' && env.APP_SECRETS_CONFIGURED != 'true'",
      "steps.verify.outputs.changed == 'true' && env.APP_SECRETS_CONFIGURED == 'true'",
    ]);
    for (const expression of expressionsIn(workflow)) {
      assert.ok(allowed.has(expression), `想定外の式: ${expression}`);
    }
    // 式を入れる env の値は、token・repository 名・script が書いた draft の真偽だけ。
    const envValues = createPr.steps
      .filter((s) => s.env)
      .flatMap((s) => Object.values(s.env));
    for (const value of envValues) {
      assert.ok(
        /^\$\{\{ (steps\.app-token\.outputs\.token|github\.repository|steps\.verify\.outputs\.draft) \}\}$/.test(
          value,
        ),
        value,
      );
    }
  });

  it("job は generate → create-pr の順で、変更があるときだけ・master のときだけ PR を作る", () => {
    assert.equal(createPr.needs, "generate");
    assert.equal(
      generate.if,
      "${{ github.repository == 'kazormia296/Grimodex' }}",
    );
    assert.match(createPr.if, /needs\.generate\.outputs\.changed == 'true'/);
    assert.match(createPr.if, /github\.repository == 'kazormia296\/Grimodex'/);
    assert.match(createPr.if, /github\.ref == 'refs\/heads\/master'/);
    assert.deepEqual(generate.outputs, {
      changed: "${{ steps.compare.outputs.changed }}",
    });
    // 生成 job が渡すのは候補の写し 1 file だけ。models.dev の応答・script は渡さない。
    const upload = generate.steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.equal(
      upload.with.path,
      "${{ runner.temp }}/candidate/model-capabilities.json",
    );
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["retention-days"], 7);
    assert.match(upload.if, /steps\.compare\.outputs\.changed == 'true'/);
    const download = createPr.steps.find((s) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    assert.equal(download.with.name, upload.with.name);
    // PR 作成 job は検証し直す（artifact は directory ごと渡し、唯一の通常の file だけを読む）。
    const verify = stepNamed(
      createPr,
      "Re-validate the candidate with the master validation module",
    );
    assert.match(verify.run, /compare/);
    assert.match(verify.run, /--candidate-dir "\$RUNNER_TEMP\/candidate"/);
    assert.match(verify.run, /--base "\$SNAPSHOT_PATH"/);
    assert.equal(
      createPr.steps.findIndex((s) => s.name === verify.name) >
        createPr.steps.findIndex((s) =>
          s.uses?.startsWith("actions/download-artifact@"),
        ),
      true,
    );
  });

  it("models.dev の取得は固定の URL に、byte の上限・時間の上限・200 の確認を付け、redirect を辿らない（T4）", () => {
    assert.equal(generate.env.MODELS_DEV_URL, "https://models.dev/api.json");
    const fetchStep = stepNamed(
      generate,
      "Fetch models.dev with byte and time limits",
    );
    const run = fetchStep.run;
    assert.match(run, /--max-filesize "\$raw_limit"/);
    assert.match(run, /--max-time \d+/);
    assert.match(run, /--connect-timeout \d+/);
    assert.match(run, /--proto '=https'/);
    assert.match(run, /--write-out '%\{http_code\}'/);
    assert.match(run, /test "\$status" = "200"/);
    assert.match(run, /test "\$size" -le "\$raw_limit"/);
    assert.match(run, /"\$MODELS_DEV_URL"/);
    assert.doesNotMatch(
      run,
      /\s-L\b|--location|--compressed|--insecure|\s-k\b/,
    );
    // 上限は数値を写さず、SNAPSHOT_POLICY から script 経由で取る。
    assert.match(run, /raw-limit/);
    assert.doesNotMatch(run, /--max-filesize\s+\d/);
    // 通信先は models.dev の 1 つだけ（push の認証 header は github.com）。
    const urls = new Set(
      allStrings([generate, createPr])
        .join("\n")
        .match(/https?:\/\/[^\s'"]+/g) ?? [],
    );
    assert.deepEqual([...urls].sort(), [
      "https://github.com/.extraheader",
      "https://models.dev/api.json",
    ]);
    assert.equal(generate["timeout-minutes"], 10);
    assert.equal(createPr["timeout-minutes"], 10);
  });

  it("raw の上限は SNAPSHOT_POLICY.maxRawBytes と一致する（raw-limit の出力）", async () => {
    const { SNAPSHOT_POLICY } =
      await import("../electron/shared/modelCapabilityRegistry.ts");
    const result = spawnSync(
      process.execPath,
      [
        path.join(
          repoRoot,
          "scripts",
          "generate-model-capability-snapshot.mjs",
        ),
        "raw-limit",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), String(SNAPSHOT_POLICY.maxRawBytes));
  });

  it("固定の枝に 1 file だけを commit し、master へは push せず、PR の base は master（T7・Q7）", () => {
    assert.equal(
      createPr.env.AUTOMATION_BRANCH,
      "automation/model-capabilities",
    );
    assert.equal(
      createPr.env.SNAPSHOT_PATH,
      "electron/resources/model-capabilities.json",
    );
    const push = stepNamed(createPr, "Push the fixed branch");
    assert.match(push.run, /git status --porcelain\)" = "M  \$SNAPSHOT_PATH"/);
    assert.match(
      push.run,
      /git push --force origin "HEAD:refs\/heads\/\$AUTOMATION_BRANCH"/,
    );
    const pushes = push.run.match(/git push[^\n]*/g);
    assert.equal(pushes.length, 1);
    assert.doesNotMatch(
      push.run,
      /refs\/heads\/master|origin master|HEAD:master/,
    );
    // token は commit・push の引数にも .git/config にも置かない（環境変数 1 回分）。
    assert.match(push.run, /GIT_CONFIG_COUNT=1/);
    assert.doesNotMatch(
      push.run,
      /git config|remote set-url|x-access-token:[^%]/,
    );
    assert.match(push.run, /::add-mask::/);
    // author は固定（upstream の値を使わない）。
    assert.match(push.run, /user\.name='github-actions\[bot\]'/);
    assert.match(
      push.run,
      /user\.email='41898282\+github-actions\[bot\]@users\.noreply\.github\.com'/,
    );
    const open = stepNamed(createPr, "Open or update the PR");
    assert.match(open.run, /-f base=master/);
    assert.match(open.run, /-F body=@"\$RUNNER_TEMP\/pr-body\.md"/);
    // draft は script が決めた真偽（検証し直した結果）で、PR の状態を合わせる。
    assert.match(open.run, /case "\$DRAFT" in true \| false\)/);
    assert.match(
      open.run,
      /gh pr ready "\$number" --repo "\$REPOSITORY" --undo/,
    );
  });

  it("T10: 古さの警告は script が summary に出す（30 日）", async () => {
    const run = runOf(generate);
    assert.match(run, /--summary "\$GITHUB_STEP_SUMMARY"/);
    const script = await readFile(
      path.join(repoRoot, "scripts", "generate-model-capability-snapshot.mjs"),
      "utf8",
    );
    assert.match(script, /staleWarningDays: 30/);
  });

  it("step は想定した key だけを持つ", () => {
    for (const job of [generate, createPr]) {
      for (const step of job.steps) {
        assert.deepEqual(
          Object.keys(step).filter(
            (key) =>
              !["name", "id", "if", "uses", "with", "run", "env"].includes(key),
          ),
          [],
          step.name ?? step.uses,
        );
      }
    }
  });
});
