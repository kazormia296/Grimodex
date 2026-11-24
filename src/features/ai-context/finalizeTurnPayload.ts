import type { AiProvider } from "@/features/chat/types";
import type { TurnPayloadProvider } from "../../../electron/shared/turnPayloadFinalizer";

type Assert<T extends true> = T;
export type RendererAiProviderCompatibility = Assert<
  [AiProvider] extends [TurnPayloadProvider]
    ? [TurnPayloadProvider] extends [AiProvider]
      ? true
      : false
    : false
>;

export * from "../../../electron/shared/turnPayloadFinalizer";
