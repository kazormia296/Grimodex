import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

const LINE_WIDTHS = [100, 96, 88, 72, 94, 68, 90, 55] as const;

interface EditorContentSkeletonProps {
  className?: string;
  lineHeight?: number;
}

export function EditorContentSkeleton({
  className,
  lineHeight = 1.8,
}: EditorContentSkeletonProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn("space-y-3 py-1", className)}
      aria-busy="true"
      aria-label={t("editor.loadingContent")}
      data-testid="editor-content-loading"
    >
      {LINE_WIDTHS.map((width, index) => (
        <Skeleton
          key={index}
          className="h-[1em] rounded-sm"
          style={{ width: `${width}%`, lineHeight }}
        />
      ))}
    </div>
  );
}

interface EditorBodyWithLoadingProps {
  isLoading: boolean;
  children: React.ReactNode;
}

/** Covers editor body with a skeleton while scene content is loading. */
export function EditorBodyWithLoading({
  isLoading,
  children,
}: EditorBodyWithLoadingProps) {
  return (
    <div className="relative">
      {isLoading && (
        <div className="absolute inset-0 z-10 bg-content-background">
          <EditorContentSkeleton />
        </div>
      )}
      <div className={cn(isLoading && "invisible")}>{children}</div>
    </div>
  );
}
