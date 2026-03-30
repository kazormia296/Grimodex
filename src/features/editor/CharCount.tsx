interface CharCountProps {
  count: number;
}

export function CharCount({ count }: CharCountProps) {
  return (
    <span data-testid="char-count" className="text-sm text-muted-foreground">
      {count}
    </span>
  );
}
