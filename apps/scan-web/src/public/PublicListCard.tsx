interface PublicListCardProps {
  title: string;
  items: string[];
}

export function PublicListCard({ title, items }: PublicListCardProps) {
  return (
    <section className="scan-card">
      <h2>{title}</h2>
      <div className="scan-chip-row">
        {items.map((item) => (
          <span className="scan-chip" key={item}>
            {item}
          </span>
        ))}
      </div>
    </section>
  );
}
