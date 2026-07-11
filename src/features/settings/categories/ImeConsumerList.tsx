import { useTranslation } from "react-i18next";
import type {
  ImeConsumerCapabilities,
  ImeConsumerInfo,
  ImeConsumerPlatform,
} from "@/features/ime/api";

interface ImeConsumerListProps {
  consumers: ImeConsumerInfo[];
}

const PLATFORM_KEYS: Record<ImeConsumerPlatform, string> = {
  linux: "settings.codex.imePlatformLinux",
  windows: "settings.codex.imePlatformWindows",
  macos: "settings.codex.imePlatformMacos",
};

const CAPABILITY_KEYS: Array<[keyof ImeConsumerCapabilities, string]> = [
  ["dynamicDictionary", "settings.codex.imeCapabilityDynamicDictionary"],
  ["zenzaiV3Conditions", "settings.codex.imeCapabilityZenzaiV3"],
  ["applicationScoping", "settings.codex.imeCapabilityApplicationScoping"],
];

export function ImeConsumerList({ consumers }: ImeConsumerListProps) {
  const { t } = useTranslation();

  return (
    <ul className="mt-1 space-y-1.5 text-muted-foreground">
      {consumers.map((consumer) => (
        <li
          key={consumer.consumerId}
          className="flex flex-wrap items-center gap-1"
        >
          <span className="mr-1 text-foreground">{consumer.name}</span>
          <span className="font-mono text-[10px]">v{consumer.version}</span>
          {consumer.platform && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
              {t(PLATFORM_KEYS[consumer.platform])}
            </span>
          )}
          {CAPABILITY_KEYS.filter(
            ([capability]) => consumer.capabilities[capability],
          ).map(([capability, key]) => (
            <span
              key={capability}
              className="rounded border border-border px-1.5 py-0.5 text-[10px]"
            >
              {t(key)}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}
