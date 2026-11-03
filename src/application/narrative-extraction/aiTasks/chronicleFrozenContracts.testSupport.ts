import { readFileSync } from "node:fs";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import type {
  ChroniclePromptArtifact,
  ChroniclePromptComponentContract,
} from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";

export const MATERIAL_ROSTER_DIRECTORY =
  "src-tauri/crates/grimodex-db/src/narrative_extraction/material_roster/";

type ContractsByStage = Record<string, ChroniclePromptComponentContract>;

/** Native が replay に使う現行の契約（TS の builder と byte parity）。 */
export function currentFrozenContracts(): ContractsByStage {
  return JSON.parse(
    readFileSync(MATERIAL_ROSTER_DIRECTORY + "contracts.json", "utf8"),
  ) as ContractsByStage;
}

/** 退役したが、既存の receipt を replay するために凍結して残す契約。 */
export function supersededFrozenContracts(): Record<
  string,
  readonly ChroniclePromptComponentContract[]
> {
  return JSON.parse(
    readFileSync(
      MATERIAL_ROSTER_DIRECTORY + "superseded-contracts.json",
      "utf8",
    ),
  ) as Record<string, readonly ChroniclePromptComponentContract[]>;
}

/** receipt の component contract digest に一致する凍結済みの契約（現行と退役の両方から探す）。 */
export async function frozenContractForDigest(
  stageId: string,
  digest: string,
): Promise<ChroniclePromptComponentContract | null> {
  const current = currentFrozenContracts()[stageId];
  const candidates = [
    ...(current ? [current] : []),
    ...(supersededFrozenContracts()[stageId] ?? []),
  ];
  for (const componentContract of candidates) {
    const candidateDigest = await digestStableJson({
      schemaVersion: 1,
      contextSetVersion: "chronicle.context-set/1",
      stageId,
      componentContract,
    });
    if (candidateDigest === digest) return componentContract;
  }
  return null;
}

/**
 * live の builder が組んだ Context Set の部分はそのままに、指示と出力例だけを
 * 凍結済みの契約へ差し替えた artifact を返す（Native の replay と同じ組み立て）。
 */
export function withComponentContract(
  artifact: ChroniclePromptArtifact,
  componentContract: ChroniclePromptComponentContract,
): ChroniclePromptArtifact {
  const live = artifact.componentContract;
  const content = artifact.messages[0].content;
  const head = `${live.instruction}\n\n`;
  const tail = `\n${live.outputShape}`;
  if (!content.startsWith(head) || !content.endsWith(tail)) {
    throw new Error("live prompt does not frame its component contract");
  }
  const body = content.slice(head.length, content.length - tail.length);
  return {
    ...artifact,
    componentContract,
    messages: [
      {
        role: "user",
        content: `${componentContract.instruction}\n\n${body}\n${componentContract.outputShape}`,
      },
    ],
  };
}
