import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAnthropicBody,
  sendAnthropicMessages,
  ANTHROPIC_MESSAGES_URL,
} from "../chronicle-prompt-cache-diag/anthropicPayload";
import { assertWithinCap, estimateCost, PRICES } from "./cost";
import { buildPair, cases } from "./prompts";
import { score } from "./score";

const key = process.env.ANTHROPIC_API_KEY;
const run = key ? describe : describe.skip;
const model = process.env.B1_MODEL ?? "claude-haiku-5-5";
const effort = process.env.B1_EFFORT ?? "low";
const reps = Number(process.env.B1_REPS ?? 3);
const cap = Number(process.env.B1_CAP ?? 3);
const maxTokens = Number(process.env.B1_MAX_TOKENS ?? 4000);
const here = path.dirname(fileURLToPath(import.meta.url));
const countTokensUrl = `${ANTHROPIC_MESSAGES_URL}/count_tokens`;

async function countInput(
  body: ReturnType<typeof buildAnthropicBody>,
): Promise<number> {
  const response = await fetch(countTokensUrl, {
    method: "POST",
    headers: {
      "x-api-key": key!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      system: body.system,
      messages: body.messages,
    }),
  });
  if (!response.ok)
    throw new Error(`count_tokens failed: HTTP ${response.status}`);
  const data = (await response.json()) as { input_tokens: number };
  return data.input_tokens;
}

run("B1 live approved Codex rank evaluation", () => {
  it("counts all requests before sending, then records answers without prompts", async () => {
    const schedule = cases.flatMap((item, caseIndex) => {
      const pair = buildPair(item);
      return Array.from({ length: reps }, (_, index) => {
        const order =
          (caseIndex + index) % 2 === 0
            ? (["control", "approved"] as const)
            : (["approved", "control"] as const);
        return order.map((group) => ({ item, group, rep: index + 1, pair }));
      }).flat();
    });
    const prepared = await Promise.all(
      schedule.map(async (entry) => {
        const prompt =
          entry.group === "approved"
            ? entry.pair.ranked.prompt
            : entry.pair.control.prompt;
        const body = buildAnthropicBody({
          model,
          maxTokens,
          messages: [
            { role: "user", content: entry.item.userMessage },
            { role: "system", content: prompt },
          ],
        });
        const inputTokens = await countInput(body);
        return {
          ...entry,
          body: {
            ...body,
            messages: [{ role: "user", content: entry.item.userMessage }],
            system: prompt,
          },
          inputTokens,
        };
      }),
    );
    const price = PRICES[model as keyof typeof PRICES];
    if (!price) throw new Error("unsupported model");
    const estimate = prepared.reduce(
      (total, item) =>
        total +
        estimateCost(model as keyof typeof PRICES, item.inputTokens, maxTokens),
      0,
    );
    assertWithinCap(estimate, cap);
    const records = [];
    const output = path.resolve(
      here,
      "../../..",
      ".artifacts/b1-approved-codex-rank-eval",
      `run-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
    );
    await mkdir(path.dirname(output), { recursive: true });
    // Write after every send so an interrupted run still shows what was sent.
    const writeResult = (complete: boolean) =>
      writeFile(
        output,
        `${JSON.stringify(
          {
            model,
            effort,
            estimatedCostUsd: estimate,
            complete,
            refusalCount: records.filter(
              (record) => record.stopReason === "refusal",
            ).length,
            records,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    for (const entry of prepared) {
      const response = await sendAnthropicMessages({
        apiKey: key!,
        body: {
          ...entry.body,
          model,
          max_tokens: maxTokens,
          messages: entry.body.messages,
          system: entry.body.system,
          output_config: { effort },
        } as typeof entry.body & { output_config: { effort: string } },
        maxAttempts: 1,
      });
      const result =
        response.stopReason === "refusal"
          ? null
          : score(response.text, entry.item.expected, entry.item.forbidden);
      records.push({
        case: entry.item.id,
        group: entry.group,
        rep: entry.rep,
        correct: result?.correct ?? null,
        forbiddenCount: result?.forbiddenCount ?? null,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        stopReason: response.stopReason,
      });
      await writeResult(false);
    }
    await writeResult(true);
    expect(records).toHaveLength(schedule.length);
  });
});
