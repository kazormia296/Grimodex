import { useRef, useEffect } from "react";

interface Props {
  x: number;
  y: number;
  entryName: string;
  entryType: string;
  isPinned: boolean;
  isSectionCollapsed: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  onHide: () => void;
  onToggleTypeSection: () => void;
  onRemoveFromSet?: () => void;
}

export function ColumnHeaderMenu({
  x,
  y,
  entryName,
  entryType,
  isPinned,
  isSectionCollapsed,
  onClose,
  onTogglePin,
  onHide,
  onToggleTypeSection,
  onRemoveFromSet,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const items = [
    {
      label: isPinned ? `ピン解除: ${entryName}` : `先頭にピン: ${entryName}`,
      action: onTogglePin,
    },
    {
      label: `列を非表示: ${entryName}`,
      action: onHide,
    },
    {
      label: isSectionCollapsed
        ? `「${entryType}」セクションを展開`
        : `「${entryType}」セクションを折りたたむ`,
      action: onToggleTypeSection,
    },
  ];

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[200px] rounded-md border border-border bg-popover py-1 shadow-md"
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className="block w-full px-3 py-1.5 text-left text-xs hover:bg-accent"
          onClick={() => {
            item.action();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
      {onRemoveFromSet && (
        <>
          <div className="my-1 border-t border-border/50" />
          <button
            type="button"
            className="block w-full px-3 py-1.5 text-left text-xs text-destructive hover:bg-accent"
            onClick={() => {
              onRemoveFromSet();
              onClose();
            }}
          >
            セットから削除
          </button>
        </>
      )}
    </div>
  );
}
