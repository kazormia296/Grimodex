import { useState, useEffect, useMemo } from "react";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { parseLicensesMarkdown } from "@/features/licenses/parser";
import type { LicenseEntry } from "@/features/licenses/types";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; npm: LicenseEntry[]; cargo: LicenseEntry[] };

function LicenseBadge({ license }: { license: string }) {
  const isPermissive = /^(MIT|ISC|BSD|Apache|CC0|Unlicense|0BSD)/i.test(
    license,
  );
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] ${
        isPermissive
          ? "bg-green-500/10 text-green-700 dark:text-green-400"
          : "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
      }`}
    >
      {license}
    </span>
  );
}

function EntryItem({ entry }: { entry: LicenseEntry }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border/40 py-2 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span className="font-medium text-foreground text-sm">
            {entry.name}
          </span>
          <span className="ml-1.5 text-xs text-muted-foreground">
            {entry.version}
          </span>
          {entry.repository && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {entry.repository}
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <LicenseBadge license={entry.license} />
          {entry.licenseText && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {open ? t("common.close") : t("settings.about.full")}
            </button>
          )}
        </div>
      </div>
      {open && entry.licenseText && (
        <pre className="mt-2 max-h-48 overflow-y-auto rounded bg-muted p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {entry.licenseText}
        </pre>
      )}
    </div>
  );
}

function EntryList({
  title,
  entries,
  query,
}: {
  title: string;
  entries: LicenseEntry[];
  query: string;
}) {
  const filtered = useMemo(() => {
    if (!query) return entries;
    const q = query.toLowerCase();
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.license.toLowerCase().includes(q),
    );
  }, [entries, query]);

  if (filtered.length === 0) return null;

  return (
    <section className="mb-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}{" "}
        <span className="font-normal normal-case">({filtered.length})</span>
      </h3>
      <div>
        {filtered.map((e) => (
          <EntryItem key={`${e.name}@${e.version}`} entry={e} />
        ))}
      </div>
    </section>
  );
}

export function LicensesSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/THIRD_PARTY_LICENSES.md")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        const { npm, cargo } = parseLicensesMarkdown(text);
        setState({ status: "ok", npm, cargo });
      })
      .catch((err: unknown) => {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  if (state.status === "loading") {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="py-6 text-sm text-destructive">
        {t("settings.about.loadError", { message: state.message })}
      </div>
    );
  }

  const total = state.npm.length + state.cargo.length;
  const lowerQuery = query.toLowerCase();
  const noMatch =
    query &&
    state.npm.filter(
      (e) =>
        e.name.toLowerCase().includes(lowerQuery) ||
        e.license.toLowerCase().includes(lowerQuery),
    ).length === 0 &&
    state.cargo.filter(
      (e) =>
        e.name.toLowerCase().includes(lowerQuery) ||
        e.license.toLowerCase().includes(lowerQuery),
    ).length === 0;

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        {t("settings.about.thirdPartyLicenses")}
      </h3>
      <div className="mb-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder={t("settings.about.searchPlaceholder", {
              count: total,
            })}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>
      <EntryList
        title={t("settings.about.npmPackages")}
        entries={state.npm}
        query={query}
      />
      <EntryList
        title={t("settings.about.rustCrates")}
        entries={state.cargo}
        query={query}
      />
      {noMatch && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t("settings.about.notFound", { query })}
        </p>
      )}
    </section>
  );
}
