import { WindowControls } from "./WindowControls";

export function TitleBar() {
  return (
    <div
      className="fixed top-0 right-0 left-0 z-50 flex h-8 items-center justify-end"
      data-tauri-drag-region
    >
      <WindowControls />
    </div>
  );
}
