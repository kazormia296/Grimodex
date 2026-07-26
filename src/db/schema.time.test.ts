import { describe, expect, it } from "vitest";
import {
  codexChunks,
  foreshadows,
  foreshadowSetups,
  sceneChunks,
} from "./schema";

interface EpochMillisecondsColumn {
  mapFromDriverValue(value: number): Date;
  mapToDriverValue(value: Date): number;
}

const EPOCH_MILLISECONDS_COLUMNS = [
  ["foreshadows.codexLinkDirtyAt", foreshadows.codexLinkDirtyAt],
  ["foreshadows.createdAt", foreshadows.createdAt],
  ["foreshadows.updatedAt", foreshadows.updatedAt],
  ["foreshadowSetups.lastEvaluatedAt", foreshadowSetups.lastEvaluatedAt],
  ["foreshadowSetups.createdAt", foreshadowSetups.createdAt],
  ["foreshadowSetups.updatedAt", foreshadowSetups.updatedAt],
  ["sceneChunks.createdAt", sceneChunks.createdAt],
  ["sceneChunks.updatedAt", sceneChunks.updatedAt],
  ["codexChunks.createdAt", codexChunks.createdAt],
  ["codexChunks.updatedAt", codexChunks.updatedAt],
] as const;

describe("epoch-millisecond Drizzle columns", () => {
  it.each(EPOCH_MILLISECONDS_COLUMNS)(
    "%s round-trips Rust timestamp_millis values without scaling",
    (_label, drizzleColumn) => {
      const column = drizzleColumn as unknown as EpochMillisecondsColumn;
      const epochMilliseconds = 1_784_116_800_123;

      expect(column.mapFromDriverValue(epochMilliseconds).getTime()).toBe(
        epochMilliseconds,
      );
      expect(column.mapToDriverValue(new Date(epochMilliseconds))).toBe(
        epochMilliseconds,
      );
    },
  );
});
