import * as React from "react";
import { cn } from "../../lib/utils";
import "./kit.css";
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn("ui-input", className)}
    ref={ref}
    {...props}
  />
));
Input.displayName = "Input";
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    className={cn("ui-input ui-textarea", className)}
    ref={ref}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export interface NumberInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "min" | "max" | "step"
> {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  label?: string;
}
/** Keep a draft so a number can be cleared and edited without jumping to one. */
export function NumberInput({
  value,
  onValueChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  label,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: NumberInputProps) {
  const [draft, setDraft] = React.useState(String(value));
  const editing = React.useRef(false),
    cancel = React.useRef(false);
  const initial = React.useRef(value);
  React.useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);
  const bound = (number: number) => Math.max(min, Math.min(max, number));
  return (
    <Input
      {...props}
      type="number"
      inputMode="decimal"
      aria-label={label ?? props["aria-label"]}
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={(event) => {
        editing.current = true;
        initial.current = value;
        onFocus?.(event);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (next.trim() !== "" && Number.isFinite(Number(next)))
          onValueChange(bound(Number(next)));
      }}
      onBlur={(event) => {
        editing.current = false;
        if (cancel.current) {
          cancel.current = false;
          setDraft(String(initial.current));
          onValueChange(initial.current);
        } else {
          const number = bound(
            draft.trim() === "" || !Number.isFinite(Number(draft))
              ? min
              : Number(draft),
          );
          setDraft(String(number));
          onValueChange(number);
        }
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancel.current = true;
          event.currentTarget.blur();
        }
        onKeyDown?.(event);
      }}
    />
  );
}
