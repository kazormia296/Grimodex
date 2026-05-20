import { EditorToggleIcon } from "./EditorToggleIcon";
import { RegionStripe } from "./RegionStripe";
import { useCenterSegments } from "./useCenterSegments";

/**
 * 中央領域の最上段に常設される水平ストライプ（§4 of layout design doc）。
 *
 * editor 開閉トグル（EditorToggleIcon）と center tool アイコンを並べる。
 * editor の開閉や center tool の有無に関わらず常に表示される。
 */
export function CenterStripe() {
  const segments = useCenterSegments();

  return (
    <div
      data-center-stripe
      className="flex h-full w-full min-w-0 items-stretch overflow-hidden border-b border-border bg-background/40"
    >
      <EditorToggleIcon />
      <div className="min-w-0 flex-1">
        <RegionStripe
          region="center"
          orientation="horizontal"
          segments={segments}
        />
      </div>
    </div>
  );
}
