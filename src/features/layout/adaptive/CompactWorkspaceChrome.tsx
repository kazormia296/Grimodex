interface Props {
  active: boolean;
}

export function CompactWorkspaceChrome({ active }: Props) {
  return (
    <div
      data-adaptive-chrome="compact"
      data-active={String(active)}
      aria-hidden={!active}
      {...(!active ? { inert: true } : {})}
    />
  );
}
