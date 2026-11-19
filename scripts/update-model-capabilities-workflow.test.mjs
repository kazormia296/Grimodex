/**
 * 定期 workflow（.github/workflows/update-model-capabilities.yml）の試験。
 * 仕様の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §3.3（T4・T7・T10）と §7、§7.6。
 *
 * 前半は構造の静的な試験。後半は create-pr job の step を、偽の gh とローカルの bare repo で順に動かす
 * 模擬（通信なし）で、既存の PR があるときの順序（draft にしてから push）と、draft にできなかったときに
 * push しないこと、自動で ready にしないこと等を確かめる。workflow 自体は実行しない。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

import { formatSnapshotFile } from "./generate-model-capability-snapshot.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptPath = path.join(
  repoRoot,
  "scripts",
  "generate-model-capability-snapshot.mjs",
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
const STEP_NAMES = {
  verify: "Re-validate the candidate with the master validation module",
  failMissing: "Fail because the GitHub App secrets are missing after setup",
  skipMissing:
    "Skip PR creation because the GitHub App secrets are not set yet",
  token: "Create the GitHub App token",
  lookup: "Look up the open PR of the fixed branch",
  close: "Close the stale PR because master already matches",
  same: "Compare the PR branch snapshot with the candidate",
  draft: "Draft the existing PR before pushing",
  push: "Push the fixed branch",
  open: "Open or update the PR",
  stale: "Fail when the master snapshot is stale after setup",
};

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

function indexOfStep(job, name) {
  const index = job.steps.findIndex((candidate) => candidate.name === name);
  assert.ok(index >= 0, `step が無い: ${name}`);
  return index;
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

describe("update-model-capabilities workflow（構造）", () => {
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

  it("secrets と variable は create-pr だけが使い、名前は決めたものに限る。create-pr は Environment を使う", () => {
    assert.doesNotMatch(JSON.stringify(generate), /secrets\.|vars\./);
    assert.equal(generate.environment, undefined);
    // secret は master だけに限った Environment に置く（別の枝からの dispatch で使えない）。
    assert.equal(createPr.environment, "model-capabilities");
    const secretRefs = allStrings(workflow)
      .join("\n")
      .match(/secrets\.\w+/g)
      .map((name) => name.replace("secrets.", ""));
    assert.deepEqual([...new Set(secretRefs)].sort(), [...SECRET_NAMES].sort());
    const varRefs = new Set(
      allStrings(workflow)
        .join("\n")
        .match(/vars\.\w+/g) ?? [],
    );
    assert.deepEqual([...varRefs], ["vars.MODEL_REGISTRY_CONFIGURED"]);
    assert.equal(
      createPr.env.MODEL_REGISTRY_CONFIGURED,
      "${{ vars.MODEL_REGISTRY_CONFIGURED }}",
    );
    assert.equal(
      createPr.env.APP_SECRETS_CONFIGURED,
      "${{ secrets.MODEL_REGISTRY_APP_CLIENT_ID != '' && secrets.MODEL_REGISTRY_APP_PRIVATE_KEY != '' }}",
    );
  });

  it("App の token は pin した公式の action で、contents と pull-requests の write だけに絞る", () => {
    const step = stepNamed(createPr, STEP_NAMES.token);
    assert.equal(step.id, "app-token");
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
    // 発行は secret が設定済みのときだけ（変更が無くても、古い PR を閉じるために発行する）。
    assert.equal(step.if, "${{ env.APP_SECRETS_CONFIGURED == 'true' }}");
    // token を使う step は、すべて発行 step より後にある。
    const tokenIndex = indexOfStep(createPr, STEP_NAMES.token);
    for (const name of [
      STEP_NAMES.lookup,
      STEP_NAMES.close,
      STEP_NAMES.same,
      STEP_NAMES.draft,
      STEP_NAMES.push,
      STEP_NAMES.open,
    ]) {
      assert.ok(indexOfStep(createPr, name) > tokenIndex, name);
      assert.match(
        stepNamed(createPr, name).if,
        /APP_SECRETS_CONFIGURED == 'true'/,
      );
    }
  });

  it("secret の欠落：設定の完了前は警告で成功、完了後（variable が true）は失敗にする", () => {
    const verify = stepNamed(createPr, STEP_NAMES.verify);
    // 検証は secret や variable に依らず実行する。
    assert.equal(verify.if, undefined);
    const skip = stepNamed(createPr, STEP_NAMES.skipMissing);
    assert.equal(
      skip.if,
      "${{ env.APP_SECRETS_CONFIGURED != 'true' && env.MODEL_REGISTRY_CONFIGURED != 'true' && steps.verify.outputs.changed == 'true' }}",
    );
    assert.match(skip.run, /::warning/);
    assert.match(skip.run, /GITHUB_STEP_SUMMARY/);
    assert.match(skip.run, /secret 未設定/);
    assert.doesNotMatch(skip.run, /exit [1-9]/);
    const fail = stepNamed(createPr, STEP_NAMES.failMissing);
    assert.equal(
      fail.if,
      "${{ env.APP_SECRETS_CONFIGURED != 'true' && env.MODEL_REGISTRY_CONFIGURED == 'true' }}",
    );
    assert.match(fail.run, /::error/);
    assert.match(fail.run, /exit 1/);
    // どちらも token の発行より前に決まる。
    assert.ok(
      indexOfStep(createPr, STEP_NAMES.failMissing) <
        indexOfStep(createPr, STEP_NAMES.token),
    );
  });

  it("T10：古さは、設定の完了後だけ、PR の作成・更新の後に失敗にする", () => {
    const stale = stepNamed(createPr, STEP_NAMES.stale);
    assert.equal(
      stale.if,
      "${{ steps.verify.outputs.stale == 'true' && env.MODEL_REGISTRY_CONFIGURED == 'true' }}",
    );
    assert.match(stale.run, /exit 1/);
    // 最後の step（失敗が更新 PR の作成・更新を妨げない）。
    assert.equal(createPr.steps.at(-1).name, STEP_NAMES.stale);
    // generate 側は警告だけ（script が summary と warning を出す）。
    assert.doesNotMatch(runOf(generate), /exit 1/);
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
      "github.repository == 'kazormia296/Grimodex' && github.ref == 'refs/heads/master'",
      "secrets.MODEL_REGISTRY_APP_CLIENT_ID != '' && secrets.MODEL_REGISTRY_APP_PRIVATE_KEY != ''",
      "secrets.MODEL_REGISTRY_APP_CLIENT_ID",
      "secrets.MODEL_REGISTRY_APP_PRIVATE_KEY",
      "vars.MODEL_REGISTRY_CONFIGURED",
      "github.run_id",
      "runner.temp",
      "github.repository",
      "steps.app-token.outputs.token",
      "steps.verify.outputs.draft",
      "steps.pr.outputs.number",
      // step の if（env と、script が書いた step の output の比較だけ。値は代入しない）。
      "env.APP_SECRETS_CONFIGURED == 'true'",
      "env.APP_SECRETS_CONFIGURED != 'true' && env.MODEL_REGISTRY_CONFIGURED == 'true'",
      "env.APP_SECRETS_CONFIGURED != 'true' && env.MODEL_REGISTRY_CONFIGURED != 'true' && steps.verify.outputs.changed == 'true'",
      "env.APP_SECRETS_CONFIGURED == 'true' && steps.verify.outputs.changed != 'true' && steps.pr.outputs.number != ''",
      "env.APP_SECRETS_CONFIGURED == 'true' && steps.verify.outputs.changed == 'true' && steps.pr.outputs.number != ''",
      "env.APP_SECRETS_CONFIGURED == 'true' && steps.verify.outputs.changed == 'true' && steps.pr.outputs.number != '' && steps.same.outputs.same != 'true' && steps.verify.outputs.draft == 'true' && steps.pr.outputs.is_draft != 'true'",
      "env.APP_SECRETS_CONFIGURED == 'true' && steps.verify.outputs.changed == 'true' && steps.same.outputs.same != 'true'",
      "steps.verify.outputs.stale == 'true' && env.MODEL_REGISTRY_CONFIGURED == 'true'",
    ]);
    for (const expression of expressionsIn(workflow)) {
      assert.ok(allowed.has(expression), `想定外の式: ${expression}`);
    }
    // 式を入れる step の env の値は、token・repository 名・script が書いた draft の真偽と PR の番号だけ。
    const envValues = createPr.steps
      .filter((s) => s.env)
      .flatMap((s) => Object.values(s.env));
    for (const value of envValues) {
      assert.ok(
        /^\$\{\{ (steps\.app-token\.outputs\.token|github\.repository|steps\.verify\.outputs\.draft|steps\.pr\.outputs\.number) \}\}$/.test(
          value,
        ),
        value,
      );
    }
  });

  it("job の配線：create-pr は generate の後、master のときだけ動き、変更の有無は自分で決める", () => {
    assert.equal(createPr.needs, "generate");
    assert.equal(
      generate.if,
      "${{ github.repository == 'kazormia296/Grimodex' }}",
    );
    assert.equal(
      createPr.if,
      "${{ github.repository == 'kazormia296/Grimodex' && github.ref == 'refs/heads/master' }}",
    );
    // 生成 job の判断（output）は使わない。
    assert.equal(generate.outputs, undefined);
    assert.doesNotMatch(structured, /needs\.generate\.outputs/);
    // 生成 job が渡すのは候補の写し 1 file だけ（変更が無くても渡す。古い PR を閉じる判断は create-pr が行う）。
    const upload = generate.steps.find((s) =>
      s.uses?.startsWith("actions/upload-artifact@"),
    );
    assert.equal(upload.if, undefined);
    assert.equal(
      upload.with.path,
      "${{ runner.temp }}/candidate/model-capabilities.json",
    );
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with["retention-days"], 7);
    const download = createPr.steps.find((s) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    assert.equal(download.with.name, upload.with.name);
    // PR 作成 job は検証し直す（artifact は directory ごと渡し、唯一の通常の file だけを読む）。
    const verify = stepNamed(createPr, STEP_NAMES.verify);
    assert.match(verify.run, /compare/);
    assert.match(verify.run, /--candidate-dir "\$RUNNER_TEMP\/candidate"/);
    assert.match(verify.run, /--base "\$SNAPSHOT_PATH"/);
    assert.ok(
      indexOfStep(createPr, STEP_NAMES.verify) >
        createPr.steps.findIndex((s) =>
          s.uses?.startsWith("actions/download-artifact@"),
        ),
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
    // redirect を辿る・圧縮を伸長する・証明書を検証しない option を、長い形でも短い形（-sL、-fsSLk 等の連結）でも拒否する。
    assert.doesNotMatch(run, /--location|--compressed|--insecure|--proxy/);
    assert.doesNotMatch(run, /(^|\s)-[A-Za-z]*[LkxO][A-Za-z]*(?=\s|$)/m);
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

  it("curl の短い option の連結（-sL 等）を、上の検出が捕まえる", () => {
    const detect = (line) =>
      /(^|\s)-[A-Za-z]*[LkxO][A-Za-z]*(?=\s|$)/m.test(line);
    for (const bad of [
      "curl -sL url",
      "curl -fsSLk url",
      "curl -L url",
      "curl -s -k url",
    ]) {
      assert.equal(detect(bad), true, bad);
    }
    for (const ok of [
      "curl --silent --show-error url",
      'test "$size" -le 1',
      "--max-time 60",
    ]) {
      assert.equal(detect(ok), false, ok);
    }
  });

  it("raw の上限は SNAPSHOT_POLICY.maxRawBytes と一致する（raw-limit の出力）", async () => {
    const { SNAPSHOT_POLICY } =
      await import("../electron/shared/modelCapabilityRegistry.ts");
    const result = spawnSync(process.execPath, [scriptPath, "raw-limit"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), String(SNAPSHOT_POLICY.maxRawBytes));
  });

  it("順序：lookup → same → draft → push → PR の更新。draft に失敗したら push に進まない", () => {
    const order = [
      STEP_NAMES.lookup,
      STEP_NAMES.same,
      STEP_NAMES.draft,
      STEP_NAMES.push,
      STEP_NAMES.open,
    ].map((name) => indexOfStep(createPr, name));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
    const draft = stepNamed(createPr, STEP_NAMES.draft);
    // 既存の PR を draft にして、draft になったことを確かめ、ならなければ失敗する。
    assert.match(
      draft.run,
      /gh pr ready "\$PR_NUMBER" --repo "\$REPOSITORY" --undo/,
    );
    assert.match(draft.run, /pulls\/\$\{PR_NUMBER\}" --jq '\.draft'/);
    assert.match(draft.run, /exit 1/);
    // 失敗を握りつぶさない・失敗後も続ける設定が無い（失敗すると、後の push と更新は動かない）。
    for (const step of createPr.steps) {
      assert.equal(step["continue-on-error"], undefined, step.name);
    }
    for (const name of [STEP_NAMES.draft, STEP_NAMES.push, STEP_NAMES.open]) {
      assert.doesNotMatch(
        stepNamed(createPr, name).if,
        /always\(\)|failure\(\)|cancelled\(\)/,
        name,
      );
    }
    // 枝の写しが候補と同じなら、draft・push・更新のどれもしない。
    for (const name of [STEP_NAMES.draft, STEP_NAMES.push, STEP_NAMES.open]) {
      assert.match(
        stepNamed(createPr, name).if,
        /steps\.same\.outputs\.same != 'true'/,
        name,
      );
    }
    assert.equal(
      stepNamed(createPr, STEP_NAMES.push).if,
      stepNamed(createPr, STEP_NAMES.open).if,
    );
    // draft にするのは判定が draft で、既存の PR が draft でないときだけ。
    assert.match(draft.if, /steps\.verify\.outputs\.draft == 'true'/);
    assert.match(draft.if, /steps\.pr\.outputs\.is_draft != 'true'/);
  });

  it("自動で ready にしない：gh pr ready は draft に戻す --undo だけ", () => {
    const commands = runOf(createPr);
    const readyCalls = commands.match(/gh pr ready[^\n]*/g);
    assert.equal(readyCalls.length, 1);
    assert.match(readyCalls[0], /--undo/);
    assert.doesNotMatch(
      runOf(createPr),
      /ready_for_review|markPullRequestReadyForReview/,
    );
    assert.doesNotMatch(
      stepNamed(createPr, STEP_NAMES.open).run,
      /gh pr ready/,
    );
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
    const push = stepNamed(createPr, STEP_NAMES.push);
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
    // push の拒否は分かる形で失敗させる（Workflows 権限による拒否の可能性を示す）。
    assert.match(push.run, /if ! GIT_CONFIG_COUNT=1/);
    assert.match(push.run, /::error title=push に失敗/);
    // author は固定（upstream の値を使わない）。
    assert.match(push.run, /user\.name='github-actions\[bot\]'/);
    assert.match(
      push.run,
      /user\.email='41898282\+github-actions\[bot\]@users\.noreply\.github\.com'/,
    );
    const open = stepNamed(createPr, STEP_NAMES.open);
    assert.match(open.run, /-f base=master/);
    assert.match(open.run, /-F body=@"\$RUNNER_TEMP\/pr-body\.md"/);
    // draft は script が決めた真偽（検証し直した結果）。新しい PR だけに渡し、既存の PR の状態は変えない。
    assert.match(open.run, /case "\$DRAFT" in true \| false\)/);
    assert.match(open.run, /-F draft="\$DRAFT"/);
  });

  it("master と差が無くなったら、open の古い PR を固定の文で閉じる", () => {
    const close = stepNamed(createPr, STEP_NAMES.close);
    assert.match(close.if, /steps\.verify\.outputs\.changed != 'true'/);
    assert.match(close.if, /steps\.pr\.outputs\.number != ''/);
    assert.match(close.run, /issues\/\$\{PR_NUMBER\}\/comments/);
    assert.match(close.run, /-f state=closed/);
    // comment は固定の文（変数を含まない）。
    const body = close.run.match(/-f body='([^']*)'/);
    assert.ok(body);
    assert.doesNotMatch(body[1], /\$/);
    // 変更があるときの push の step は、差が無いときに動かない。
    assert.match(stepNamed(createPr, STEP_NAMES.push).if, /changed == 'true'/);
  });

  it("T10: 古さの警告は script が summary に出す（30 日）", async () => {
    const run = runOf(generate);
    assert.match(run, /--summary "\$GITHUB_STEP_SUMMARY"/);
    const script = await readFile(scriptPath, "utf8");
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

// ---------------------------------------------------------------------------
// create-pr job の模擬（偽の gh、ローカルの bare repo、通信なし）
// ---------------------------------------------------------------------------

const REPOSITORY = "kazormia296/Grimodex";
const BRANCH = "automation/model-capabilities";
const SNAPSHOT_PATH = "electron/resources/model-capabilities.json";
const DAY_MS = 86_400_000;

const FAKE_GH = `#!/usr/bin/env bash
set -u
args="$*"
echo "gh $args" >> "$SIM_LOG"
case "$args" in
  "pr ready "*"--undo")
    if git --git-dir="$SIM_ORIGIN" rev-parse --verify -q "refs/heads/${BRANCH}" > /dev/null; then
      echo "BRANCH_ALREADY_PUSHED_AT_UNDO" >> "$SIM_LOG"
    fi
    if [ -f "$SIM_STATE/ready-fails" ]; then exit 1; fi
    ;;
  "pr ready "*) echo "READY_WITHOUT_UNDO" >> "$SIM_LOG" ;;
  "api repos/"*"/pulls?state=open"*) cat "$SIM_STATE/list" 2> /dev/null || true ;;
  "api repos/"*"/contents/"*)
    [ -f "$SIM_STATE/branch-file" ] || exit 1
    cat "$SIM_STATE/branch-file"
    ;;
  "api --method POST repos/"*"/issues/"*"/comments"*) ;;
  "api --method POST repos/"*"/pulls "*) echo 99 ;;
  "api --method PATCH repos/"*"/pulls/"*"state=closed"*) ;;
  "api --method PATCH repos/"*"/pulls/"*) echo "\${args#*pulls/}" | cut -d' ' -f1 ;;
  "api repos/"*"/pulls/"*) cat "$SIM_STATE/draft-after" ;;
  *) echo "unexpected gh call: $args" >&2; exit 9 ;;
esac
`;

function modelMap(count, provider = "openai", offset = 0) {
  const result = {};
  for (let i = 0; i < count; i += 1) {
    result[`${provider}/model-${offset + i}`] = {
      contextWindow: 100_000 + i,
      maxOutputTokens: 8_192,
      toolCall: true,
      reasoning: i % 2 === 0,
    };
  }
  return result;
}

function snapshotText(models, generatedAtMs) {
  return formatSnapshotFile({
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString().replace(/\.\d+Z$/, "Z"),
    source: "grimodex",
    models,
  });
}

function git(cwd, args, extraEnv = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** 評価できる if の形：\`<context> ==|!= '<値>'\` を && でつないだものだけ。 */
function evaluateIf(expression, context) {
  if (expression === undefined) return true;
  const inner = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return inner.split("&&").every((part) => {
    const match = part.trim().match(/^([\w.-]+) (==|!=) '([^']*)'$/);
    assert.ok(match, `模擬で評価できない式: ${part}`);
    const actual = context.lookup(match[1]);
    return match[2] === "==" ? actual === match[3] : actual !== match[3];
  });
}

/**
 * create-pr job の steps を、checkout・setup・download・token の発行を除いて順に動かす。
 * 失敗した step があれば、その後の step は動かさない（always() 等の step は workflow に無い）。
 */
function simulate({
  secretsSet = true,
  configured = "",
  baseModels,
  baseAgeDays = 2,
  candidateModels,
  openPr = null, // { number, draft }
  branchModels, // PR の枝の写し（無ければ読めない）
  readyFails = false,
  draftAfter = "true",
}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-caps-sim-"));
  try {
    const now = Date.now();
    const origin = path.join(root, "origin.git");
    const work = path.join(root, "work");
    const runnerTemp = path.join(root, "rt");
    const state = path.join(root, "state");
    const bin = path.join(root, "bin");
    for (const dir of [work, runnerTemp, state, bin]) {
      mkdirSync(dir, { recursive: true });
    }
    git(root, ["init", "-q", "--bare", origin]);
    git(work, ["init", "-q", "-b", "master"]);
    mkdirSync(path.join(work, "electron/resources"), { recursive: true });
    writeFileSync(
      path.join(work, SNAPSHOT_PATH),
      snapshotText(baseModels, now - baseAgeDays * DAY_MS),
    );
    git(work, ["add", "."]);
    git(work, ["commit", "-q", "-m", "base"]);
    git(work, ["remote", "add", "origin", origin]);
    git(work, ["push", "-q", "origin", "master"]);
    mkdirSync(path.join(runnerTemp, "candidate"));
    writeFileSync(
      path.join(runnerTemp, "candidate", "model-capabilities.json"),
      snapshotText(candidateModels, now - 60_000),
    );
    if (openPr) {
      writeFileSync(
        path.join(state, "list"),
        `${openPr.number}\t${openPr.draft}\n`,
      );
    }
    if (branchModels) {
      writeFileSync(
        path.join(state, "branch-file"),
        snapshotText(branchModels, now - 3 * DAY_MS),
      );
    }
    if (readyFails) writeFileSync(path.join(state, "ready-fails"), "1");
    writeFileSync(path.join(state, "draft-after"), `${draftAfter}\n`);
    writeFileSync(path.join(bin, "gh"), FAKE_GH);
    chmodSync(path.join(bin, "gh"), 0o755);
    const log = path.join(root, "gh.log");
    writeFileSync(log, "");
    const summary = path.join(root, "summary.md");
    writeFileSync(summary, "");

    const jobEnv = {
      AUTOMATION_BRANCH: createPr.env.AUTOMATION_BRANCH,
      SNAPSHOT_PATH: createPr.env.SNAPSHOT_PATH,
      APP_SECRETS_CONFIGURED: secretsSet ? "true" : "false",
      MODEL_REGISTRY_CONFIGURED: configured,
    };
    const outputs = {};
    const context = {
      lookup(name) {
        let match = name.match(/^env\.(\w+)$/);
        if (match) return jobEnv[match[1]] ?? "";
        match = name.match(/^steps\.([\w-]+)\.outputs\.(\w+)$/);
        assert.ok(match, `模擬で解決できない参照: ${name}`);
        return outputs[match[1]]?.[match[2]] ?? "";
      },
    };
    const resolve = (value) =>
      String(value).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expression) => {
        if (expression === "github.repository") return REPOSITORY;
        return context.lookup(expression);
      });

    const ran = [];
    let failed = null;
    for (const step of createPr.steps) {
      if (failed) break;
      if (!evaluateIf(step.if, context)) continue;
      if (step.uses) {
        // checkout・setup-node・download-artifact は準備済み。token の発行は偽の値を出す。
        if (step.id === "app-token") {
          outputs["app-token"] = { token: "dummy-token" };
          ran.push(step.name);
        }
        continue;
      }
      const script = path.join(root, `step-${ran.length}.sh`);
      writeFileSync(
        script,
        step.run.replaceAll(
          "scripts/generate-model-capability-snapshot.mjs",
          scriptPath,
        ),
      );
      const stepOutput = path.join(root, `output-${ran.length}.txt`);
      writeFileSync(stepOutput, "");
      const env = {
        PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(
          path.delimiter,
        ),
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        ...jobEnv,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: stepOutput,
        GITHUB_STEP_SUMMARY: summary,
        SIM_LOG: log,
        SIM_STATE: state,
        SIM_ORIGIN: origin,
      };
      for (const [key, value] of Object.entries(step.env ?? {})) {
        env[key] = resolve(value);
      }
      const result = spawnSync("bash", ["-e", script], {
        cwd: work,
        encoding: "utf8",
        env,
      });
      ran.push(step.name);
      if (step.id) {
        outputs[step.id] = Object.fromEntries(
          readFileSync(stepOutput, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => [
              line.slice(0, line.indexOf("=")),
              line.slice(line.indexOf("=") + 1),
            ]),
        );
      }
      if (result.status !== 0) {
        failed = {
          name: step.name,
          stderr: result.stderr,
          stdout: result.stdout,
        };
      }
    }
    const branchPushed = (() => {
      const probe = spawnSync(
        "git",
        [
          "--git-dir",
          origin,
          "rev-parse",
          "--verify",
          "-q",
          `refs/heads/${BRANCH}`,
        ],
        { encoding: "utf8" },
      );
      return probe.status === 0;
    })();
    const changedFiles = branchPushed
      ? git(root, [
          "--git-dir",
          origin,
          "diff",
          "--name-only",
          "master",
          BRANCH,
        ])
          .split("\n")
          .filter(Boolean)
      : [];
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    return {
      ran,
      failed,
      outputs,
      branchPushed,
      changedFiles,
      calls,
      summary: readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SHRUNK = {
  base: { ...modelMap(40, "openai"), ...modelMap(10, "anthropic") },
  candidate: modelMap(20, "openai"), // 50 → 20 で急減（draft）
};
const SMALL_CHANGE = {
  base: modelMap(100),
  candidate: { ...modelMap(100), ...modelMap(2, "openai", 1_000) },
};

const linuxOnly = { skip: process.platform !== "linux" };

describe(
  "create-pr job の模擬（偽の gh とローカルの bare repo）",
  linuxOnly,
  () => {
    it("PR が無く、通常の変更：枝に 1 file だけ push し、draft でない PR を作る", () => {
      const result = simulate({
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
      });
      assert.equal(result.failed, null);
      assert.equal(result.outputs.verify.changed, "true");
      assert.equal(result.outputs.verify.draft, "false");
      assert.equal(result.branchPushed, true);
      assert.deepEqual(result.changedFiles, [SNAPSHOT_PATH]);
      const post = result.calls.find((line) => line.includes("--method POST"));
      assert.match(post, /-f base=master/);
      assert.match(post, /-F draft=false/);
      assert.equal(
        result.calls.some((line) => /pr ready|READY/.test(line)),
        false,
      );
    });

    it("既存の PR が ready で、判定が draft（急減）：push の前に draft にし、push し、ready にはしない", () => {
      const result = simulate({
        baseModels: SHRUNK.base,
        candidateModels: SHRUNK.candidate,
        openPr: { number: 7, draft: false },
        branchModels: modelMap(30, "openai"),
      });
      assert.equal(result.failed, null);
      assert.equal(result.outputs.verify.draft, "true");
      // 順序：draft にする → push → PR の更新。
      const names = [STEP_NAMES.draft, STEP_NAMES.push, STEP_NAMES.open].map(
        (name) => result.ran.indexOf(name),
      );
      assert.ok(
        names.every((index) => index >= 0),
        JSON.stringify(result.ran),
      );
      assert.deepEqual(
        names,
        [...names].sort((a, b) => a - b),
      );
      assert.ok(
        result.calls.includes(`gh pr ready 7 --repo ${REPOSITORY} --undo`),
        result.calls.join("\n"),
      );
      // draft にした時点で、枝はまだ push されていない（push の前）。
      assert.equal(
        result.calls.includes("BRANCH_ALREADY_PUSHED_AT_UNDO"),
        false,
      );
      assert.equal(result.branchPushed, true);
      assert.equal(result.calls.includes("READY_WITHOUT_UNDO"), false);
      const patch = result.calls.find((line) =>
        line.includes("--method PATCH"),
      );
      assert.ok(patch);
      assert.doesNotMatch(patch, /draft/);
    });

    it("draft にできなかったら、push せず、PR も更新せず、job を失敗させる", () => {
      const failedUndo = simulate({
        baseModels: SHRUNK.base,
        candidateModels: SHRUNK.candidate,
        openPr: { number: 7, draft: false },
        readyFails: true,
      });
      assert.equal(failedUndo.failed?.name, STEP_NAMES.draft);
      assert.equal(failedUndo.branchPushed, false);
      assert.equal(failedUndo.ran.includes(STEP_NAMES.push), false);
      assert.equal(failedUndo.ran.includes(STEP_NAMES.open), false);
      assert.equal(
        failedUndo.calls.some((line) => line.includes("--method PATCH")),
        false,
      );
      // 実行は成功したが draft になっていない（API が draft でないと答える）場合も失敗する。
      const notDraft = simulate({
        baseModels: SHRUNK.base,
        candidateModels: SHRUNK.candidate,
        openPr: { number: 7, draft: false },
        draftAfter: "false",
      });
      assert.equal(notDraft.failed?.name, STEP_NAMES.draft);
      assert.match(notDraft.failed.stdout, /draft にできません/);
      assert.equal(notDraft.branchPushed, false);
    });

    it("PR の枝の写しが候補と同じ（generatedAt を除く）なら、draft・push・更新のどれもしない", () => {
      const result = simulate({
        baseModels: SHRUNK.base,
        candidateModels: SHRUNK.candidate,
        openPr: { number: 7, draft: false },
        branchModels: SHRUNK.candidate,
      });
      assert.equal(result.failed, null);
      assert.equal(result.outputs.same.same, "true");
      assert.equal(result.branchPushed, false);
      assert.equal(
        result.calls.some((line) =>
          /--undo|--method PATCH|--method POST/.test(line),
        ),
        false,
      );
      assert.match(result.summary, /同じ内容なので、push も更新もしません/);
    });

    it("PR の枝の写しを読めない・違う内容なら、同じとはみなさず更新する", () => {
      const unreadable = simulate({
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
        openPr: { number: 7, draft: false },
      });
      assert.equal(unreadable.failed, null);
      assert.equal(unreadable.outputs.same.same, "false");
      assert.equal(unreadable.branchPushed, true);
      const different = simulate({
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
        openPr: { number: 7, draft: false },
        branchModels: modelMap(100),
      });
      assert.equal(different.outputs.same.same, "false");
      assert.equal(different.branchPushed, true);
    });

    it("既存の PR が draft で、判定が draft でない：更新するが、ready にはしない", () => {
      const result = simulate({
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
        openPr: { number: 7, draft: true },
        branchModels: modelMap(100),
      });
      assert.equal(result.failed, null);
      assert.equal(result.branchPushed, true);
      assert.equal(
        result.calls.some((line) => /pr ready|READY/.test(line)),
        false,
      );
      assert.ok(result.calls.some((line) => line.includes("--method PATCH")));
    });

    it("master と差が無くなったら、open の古い PR を固定の文で閉じ、push しない", () => {
      const result = simulate({
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.base,
        openPr: { number: 7, draft: false },
      });
      assert.equal(result.failed, null);
      assert.equal(result.outputs.verify.changed, "false");
      assert.equal(result.branchPushed, false);
      assert.ok(
        result.calls.some(
          (line) =>
            line.includes("--method POST") &&
            line.includes("issues/7/comments") &&
            line.includes("定期 workflow による自動の操作です"),
        ),
      );
      assert.ok(
        result.calls.some(
          (line) =>
            line.includes("--method PATCH") && line.includes("state=closed"),
        ),
      );
      // PR が無ければ何もしない。
      const none = simulate({
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.base,
      });
      assert.equal(none.failed, null);
      assert.equal(
        none.calls.some((line) => line.includes("--method")),
        false,
      );
    });

    it("secret が未設定：設定の完了前は警告で成功し、gh を呼ばない", () => {
      const result = simulate({
        secretsSet: false,
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
      });
      assert.equal(result.failed, null);
      assert.ok(result.ran.includes(STEP_NAMES.skipMissing));
      assert.equal(result.calls.length, 0);
      assert.equal(result.branchPushed, false);
      assert.match(result.summary, /secret 未設定/);
    });

    it("secret が未設定：設定の完了後（MODEL_REGISTRY_CONFIGURED=true）は失敗する", () => {
      const result = simulate({
        secretsSet: false,
        configured: "true",
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
      });
      assert.equal(result.failed?.name, STEP_NAMES.failMissing);
      assert.equal(result.calls.length, 0);
      assert.equal(result.branchPushed, false);
      // 差が無いときでも、設定の完了後の欠落は失敗にする。
      const unchanged = simulate({
        secretsSet: false,
        configured: "true",
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.base,
      });
      assert.equal(unchanged.failed?.name, STEP_NAMES.failMissing);
    });

    it("T10：master の写しが 30 日を超えて古い。設定の完了後は PR を更新した後に失敗し、完了前は成功する", () => {
      const afterSetup = simulate({
        configured: "true",
        baseAgeDays: 40,
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
      });
      assert.equal(afterSetup.failed?.name, STEP_NAMES.stale);
      // 失敗は更新を妨げない（枝は push され、PR は作られている）。
      assert.equal(afterSetup.branchPushed, true);
      assert.ok(afterSetup.ran.includes(STEP_NAMES.open));
      const beforeSetup = simulate({
        baseAgeDays: 40,
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
      });
      assert.equal(beforeSetup.failed, null);
      assert.equal(beforeSetup.outputs.verify.stale, "true");
      const fresh = simulate({
        configured: "true",
        baseAgeDays: 5,
        baseModels: SMALL_CHANGE.base,
        candidateModels: SMALL_CHANGE.candidate,
      });
      assert.equal(fresh.failed, null);
    });

    it("push の step：余分な変更があれば push せず、push が拒否されたら分かる形で失敗する", () => {
      // 拒否：origin を壊す（存在しない path にする）と push が失敗し、error の注釈を出す。
      const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-caps-push-"));
      try {
        const work = path.join(root, "work");
        mkdirSync(path.join(work, "electron/resources"), { recursive: true });
        git(work, ["init", "-q", "-b", "master"]);
        writeFileSync(path.join(work, SNAPSHOT_PATH), "{}\n");
        git(work, ["add", "."]);
        git(work, ["commit", "-q", "-m", "base"]);
        git(work, ["remote", "add", "origin", path.join(root, "missing.git")]);
        const runnerTemp = path.join(root, "rt");
        mkdirSync(path.join(runnerTemp, "candidate"), { recursive: true });
        writeFileSync(
          path.join(runnerTemp, "candidate", "model-capabilities.json"),
          '{"x":1}\n',
        );
        const step = stepNamed(createPr, STEP_NAMES.push);
        const result = spawnSync("bash", ["-e", "-c", step.run], {
          cwd: work,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: root,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            RUNNER_TEMP: runnerTemp,
            AUTOMATION_BRANCH: BRANCH,
            SNAPSHOT_PATH,
            GH_TOKEN: "dummy-token",
          },
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /::error title=push に失敗/);
        assert.doesNotMatch(result.stdout + result.stderr, /dummy-token/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
