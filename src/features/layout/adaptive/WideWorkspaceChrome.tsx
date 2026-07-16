interface Props {
  active: boolean;
}

export function WideWorkspaceChrome({ active }: Props) {
  return (
    <div
      data-adaptive-chrome="wide"
      data-active={String(active)}
      aria-hidden={!active}
      {...(!active ? { inert: true } : {})}
    />
  );
}
