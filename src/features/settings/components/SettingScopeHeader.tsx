interface SettingScopeHeaderProps {
  title: string;
}

export function SettingScopeHeader({ title }: SettingScopeHeaderProps) {
  return (
    <div className="mb-3 mt-4 flex items-center gap-3 first:mt-0">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
        {title}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
