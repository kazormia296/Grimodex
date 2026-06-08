import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * フォームラベルの基底コンポーネント。`htmlFor` で control と結びつける。
 * 多くは {@link Field} 経由で使う (useId で id を自動結合する)。
 */
const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "text-sm font-medium text-foreground select-none",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
