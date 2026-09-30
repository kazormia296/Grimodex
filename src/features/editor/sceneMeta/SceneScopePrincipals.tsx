import { useTranslation } from "react-i18next";
import type { Principal } from "./sceneScopeTypes";

type CharacterOption = { id: string; name: string };

function valueOf(principal: Principal): string {
  return principal.kind === "reader" ? "reader" : `character:${principal.ref}`;
}

function fromValue(value: string): Principal {
  return value === "reader"
    ? { kind: "reader" }
    : { kind: "character", ref: value.slice("character:".length) };
}

/** Reader/character principals are selected from the same-project options. */
export function SceneScopePrincipals({
  knowledgeHolder,
  audience,
  characters,
  onChange,
}: {
  knowledgeHolder: Principal;
  audience: Principal;
  characters: readonly CharacterOption[];
  onChange: (field: "knowledgeHolder" | "audience", value: Principal) => void;
}) {
  const { t } = useTranslation();
  const select = (field: "knowledgeHolder" | "audience", value: Principal) => (
    <select
      value={valueOf(value)}
      onChange={(event) => onChange(field, fromValue(event.target.value))}
      className="rounded border border-border bg-background px-1.5 py-1 text-[10px] text-foreground"
    >
      <option value="reader">reader</option>
      {characters.map((entry) => (
        <option key={entry.id} value={`character:${entry.id}`}>
          {entry.name}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">
          {t("editor.sceneDetail.holder", "Holder")}
        </span>
        {select("knowledgeHolder", knowledgeHolder)}
      </div>
      <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">
          {t("editor.sceneDetail.audience", "Audience")}
        </span>
        {select("audience", audience)}
      </div>
    </>
  );
}
