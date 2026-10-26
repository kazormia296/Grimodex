import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { useAiSettingsStore } from "@/features/chat/store";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  NIR1_LOCAL_DISCLOSURE_ITEMS,
  NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS,
  NIR1_LOCAL_PLACEMENT_LINKS_ALL,
  NIR1_LOCAL_PLACEMENT_SHOWS_ROUTE,
  type Nir1LocalDisclosureItem,
  type Nir1LocalDisclosurePlacement,
} from "./nir1LocalDisclosureItems";
import { ensureNir1LocalGenerationTranslations } from "./nir1LocalGenerationTranslations";
import { nir1LocalRoutePreview } from "./nir1LocalRoutePreview";
import type { Nir1LocalPurpose } from "./nir1LocalGenerationApi";

ensureNir1LocalGenerationTranslations();

/**
 * The disclosure of the NIR-1 local generation route at one placement (DD-1c,
 * DR-DD1C-9; K5/3 "開示" placements 1 to 3 and 5). A lazy chunk requested
 * only while `NIR1_LOCAL_GENERATION_UI_ENABLED` is on.
 *
 * It asks for nothing and keeps nothing: no confirmation, no "read" mark, no
 * state outside this component, and no send decision reads it.
 */
export default function Nir1LocalDisclosure({
  placement,
  purpose,
}: {
  readonly placement: Nir1LocalDisclosurePlacement;
  /** The generation screen's purpose (placement 3, K5/3:438). */
  readonly purpose?: Nir1LocalPurpose;
}): ReactElement | null {
  if (placement === 5) return <Nir1LocalRestrictedSummary />;
  return <Nir1LocalDisclosureBlock placement={placement} purpose={purpose} />;
}

function ItemList({
  items,
  summary,
}: {
  readonly items: readonly Nir1LocalDisclosureItem[];
  readonly summary: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ol className="space-y-1.5">
      {items.map((item) => (
        <li
          key={item}
          data-nir1-local-disclosure-item={item}
          className="break-words"
        >
          {summary ? (
            t(`nir1Local.disclosure.items.${item}.summary`)
          ) : (
            <>
              <span className="font-medium">
                {t(`nir1Local.disclosure.items.${item}.title`)}
              </span>
              {t("nir1Local.disclosure.separator")}
              {t(`nir1Local.disclosure.items.${item}.body`)}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

function RouteSummary() {
  const { t } = useTranslation();
  const settings = useAiSettingsStore((state) => state.settings);
  const preview = nir1LocalRoutePreview(settings);
  return (
    <div
      data-testid="nir1-local-route"
      data-nir1-local-route={preview.status}
      className="rounded border border-border/60 px-2 py-1"
    >
      {preview.status === "usable" ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2">
          <dt>{t("nir1Local.route.destination")}</dt>
          <dd className="break-all font-mono">{preview.destination}</dd>
          <dt>{t("nir1Local.route.model")}</dt>
          <dd className="break-all font-mono">{preview.model}</dd>
        </dl>
      ) : (
        <p data-nir1-local-route-reason={preview.reason}>
          {t(`nir1Local.route.unusable.${preview.reason}`)}
        </p>
      )}
      <p className="mt-1 text-muted-foreground">{t("nir1Local.route.note")}</p>
    </div>
  );
}

function Nir1LocalDisclosureBlock({
  placement,
  purpose,
}: {
  readonly placement: Exclude<Nir1LocalDisclosurePlacement, 5>;
  readonly purpose?: Nir1LocalPurpose;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  return (
    <section
      data-testid="nir1-local-disclosure"
      data-nir1-local-placement={placement}
      className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
    >
      <p className="font-medium">{t("nir1Local.disclosure.title")}</p>
      <p className="break-words">
        {t(`nir1Local.disclosure.placementLead.${placement}`)}
      </p>
      {purpose !== undefined && (
        <p data-testid="nir1-local-purpose" data-nir1-local-purpose={purpose}>
          {t("nir1Local.disclosure.purposeLabel")}
          {t("nir1Local.disclosure.separator")}
          {t(`nir1Local.panel.purpose.${purpose}`)}
        </p>
      )}
      {NIR1_LOCAL_PLACEMENT_SHOWS_ROUTE[placement] && <RouteSummary />}
      <ItemList
        items={
          showAll
            ? NIR1_LOCAL_DISCLOSURE_ITEMS
            : NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS[placement]
        }
        summary={false}
      />
      {NIR1_LOCAL_PLACEMENT_LINKS_ALL[placement] && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="text-primary underline-offset-2 hover:underline"
        >
          {t(
            showAll
              ? "nir1Local.disclosure.hideAll"
              : "nir1Local.disclosure.showAll",
          )}
        </button>
      )}
    </section>
  );
}

/**
 * Placement 5: the summary of items 3, 4 and 6 on the restricted status, so a
 * restricted user reaches it without opening the AI settings or the
 * generation screen (K5/3 開示の試験 (6)).
 */
function Nir1LocalRestrictedSummary() {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        data-testid="nir1-local-restricted-summary-trigger"
        aria-label={t("nir1Local.disclosure.title")}
        className="inline-flex shrink-0 items-center rounded-full p-0.5 hover:bg-muted"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        data-testid="nir1-local-disclosure"
        data-nir1-local-placement={5}
        className="z-[95] max-h-[70vh] w-80 max-w-[calc(100vw-1.5rem)] space-y-2 overflow-y-auto text-xs"
      >
        <p className="font-medium">{t("nir1Local.disclosure.title")}</p>
        <p className="break-words">
          {t("nir1Local.disclosure.placementLead.5")}
        </p>
        <ItemList
          items={
            showAll
              ? NIR1_LOCAL_DISCLOSURE_ITEMS
              : NIR1_LOCAL_DISCLOSURE_PLACEMENT_ITEMS[5]
          }
          summary={!showAll}
        />
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="text-primary underline-offset-2 hover:underline"
        >
          {t(
            showAll
              ? "nir1Local.disclosure.hideAll"
              : "nir1Local.disclosure.showAll",
          )}
        </button>
      </PopoverContent>
    </Popover>
  );
}
