import type { ReactNode } from "react";

interface DisclosureSectionProps {
  title: string;
  children: ReactNode;
}

export function DisclosureSection({ title, children }: DisclosureSectionProps) {
  return (
    <section>
      <h3 className="mb-1 font-semibold">{title}</h3>
      {children}
    </section>
  );
}
