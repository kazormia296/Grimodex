import { useProjectSettings } from "../hooks/useProjectSettings";
import { useSettingControl } from "../useSettingControl";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingTextarea } from "../components/SettingTextarea";

const GENRE_OPTIONS = [
  { value: "", label: "未選択" },
  { value: "Fantasy", label: "Fantasy" },
  { value: "Sci-Fi", label: "Sci-Fi" },
  { value: "Mystery", label: "Mystery" },
  { value: "Horror", label: "Horror" },
  { value: "Romance", label: "Romance" },
  { value: "Thriller", label: "Thriller" },
  { value: "Literary", label: "Literary" },
  { value: "Historical", label: "Historical" },
  { value: "Other", label: "Other" },
];

const POV_OPTIONS = [
  { value: "", label: "未選択" },
  { value: "First person", label: "一人称" },
  { value: "Third person limited", label: "三人称限定" },
  { value: "Third person omniscient", label: "三人称全知" },
  { value: "Second person", label: "二人称" },
];

const TENSE_OPTIONS = [
  { value: "", label: "未選択" },
  { value: "Past tense", label: "過去形" },
  { value: "Present tense", label: "現在形" },
];

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "ko", label: "한국어" },
];

const FOLDER_NAMING_OPTIONS = [
  { value: "auto", label: "自動（Part / Chapter / フォルダー）" },
  { value: "none", label: "フォルダー（固定）" },
];

const NUMBERING_SCOPE_OPTIONS = [
  { value: "project", label: "プロジェクト全体（一意）" },
  { value: "folder", label: "フォルダーごと" },
];

export function ProjectCategory() {
  const { project, isLoading, updateField } = useProjectSettings();
  const folderNaming = useSettingControl("tree.folderNaming", "auto");
  const sceneNaming = useSettingControl("tree.sceneNaming", "シーン");
  const noteNaming = useSettingControl("tree.noteNaming", "ノート");
  const numberingScope = useSettingControl("tree.numberingScope", "project");

  if (isLoading || !project) {
    return <div className="p-6 text-sm text-muted-foreground">読み込み中…</div>;
  }

  return (
    <div className="p-6">
      <SettingSection title="基本情報">
        <SettingRow label="タイトル">
          <input
            type="text"
            value={project.title}
            onChange={(e) => updateField("title", e.target.value)}
            className="w-48 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label="ジャンル">
          <select
            value={project.genre ?? ""}
            onChange={(e) => updateField("genre", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {GENRE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="視点 (POV)">
          <select
            value={project.pov ?? ""}
            onChange={(e) => updateField("pov", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {POV_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="時制">
          <select
            value={project.tense ?? ""}
            onChange={(e) => updateField("tense", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {TENSE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="執筆言語">
          <select
            value={project.language}
            onChange={(e) => updateField("language", e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <SettingSection title="ネーミングルール">
        <SettingRow label="フォルダー命名">
          <select
            value={folderNaming.value}
            onChange={(e) => folderNaming.setValue(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {FOLDER_NAMING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label="シーン命名プレフィックス"
          description={
            sceneNaming.value
              ? `例: ${sceneNaming.value} 1, ${sceneNaming.value} 2, ...`
              : "例: シーン（番号なし）"
          }
        >
          <input
            type="text"
            value={sceneNaming.value}
            onChange={(e) => sceneNaming.setValue(e.target.value)}
            placeholder="シーン"
            className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label="ノート命名プレフィックス">
          <input
            type="text"
            value={noteNaming.value}
            onChange={(e) => noteNaming.setValue(e.target.value)}
            placeholder="ノート"
            className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label="採番スコープ">
          <select
            value={numberingScope.value}
            onChange={(e) => numberingScope.setValue(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {NUMBERING_SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <SettingSection title="AI 設定">
        <div className="mb-4">
          <div className="mb-1 text-sm text-foreground">文体ガイド</div>
          <div className="text-xs text-muted-foreground mb-2">
            AIの文体を制御します。Chat のコンテキスト（Layer 1）に含まれます。
          </div>
          <SettingTextarea
            value={project.styleGuide ?? ""}
            onChange={(v) => updateField("styleGuide", v || null)}
            placeholder="文体の特徴、避けるべき表現、好む語彙など…"
            maxLength={2000}
            rows={4}
          />
        </div>
        <div>
          <div className="mb-1 text-sm text-foreground">
            AI 指示（グローバル）
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            AIの振る舞い全般を制御します。Chat のコンテキスト（Layer
            1）に含まれます。
          </div>
          <SettingTextarea
            value={project.aiInstructions ?? ""}
            onChange={(v) => updateField("aiInstructions", v || null)}
            placeholder="AIへの追加指示…"
            maxLength={4000}
            rows={5}
          />
        </div>
      </SettingSection>
    </div>
  );
}
