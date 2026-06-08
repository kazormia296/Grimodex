import * as React from "react";

import { cn } from "@/lib/utils";
import { Label } from "./label";

/**
 * control が受け取れる a11y 関連 props。Field が cloneElement で注入する。
 * native input / textarea / select や、それらに props を forward する
 * ラッパー (例: ui/input.tsx の Input) はすべて満たす。
 */
interface ControlA11yProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
}

export interface FieldProps {
  /** ラベルテキスト。 */
  label: React.ReactNode;
  /** 補足説明 (aria-describedby で control に結びつく)。 */
  help?: React.ReactNode;
  /** エラーメッセージ (aria-describedby + aria-invalid)。 */
  error?: React.ReactNode;
  /** 必須マーク + aria-required。 */
  required?: boolean;
  className?: string;
  /** ラベルの追加クラス (既存の視覚スタイルを保つため)。 */
  labelClassName?: string;
  /** ラベルを結びつける単一の control 要素。 */
  children: React.ReactElement<ControlA11yProps>;
}

function joinTokens(...tokens: Array<string | undefined>): string | undefined {
  const joined = tokens.filter(Boolean).join(" ");
  return joined.length > 0 ? joined : undefined;
}

/**
 * label ↔ control を `useId` で確実に結びつけるフォームフィールド。
 *
 * - `<label htmlFor>` ↔ control の `id` を自動結合 (id 未指定なら useId を採番、
 *   指定済みならそれを尊重)。
 * - `help` / `error` を `aria-describedby` で control に結びつける。
 * - `required` で `aria-required`、`error` で `aria-invalid` を付与。
 *
 * 既存の散らばった「視覚のみの <label>」を段階的にこれへ寄せる (中心点)。
 */
export function Field({
  label,
  help,
  error,
  required,
  className,
  labelClassName,
  children,
}: FieldProps) {
  const generatedId = React.useId();
  const controlId = children.props.id ?? generatedId;
  const helpId = help ? `${generatedId}-help` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;

  const describedBy = joinTokens(
    children.props["aria-describedby"],
    helpId,
    errorId,
  );

  const control = React.cloneElement(children, {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : children.props["aria-invalid"],
    "aria-required": required ? true : children.props["aria-required"],
  });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={controlId} className={labelClassName}>
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        )}
      </Label>
      {control}
      {help && (
        <p id={helpId} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
