import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils";
import "./kit.css";

/** shadcn/ui new-york Button structure, using the studio's CSS design tokens. */
type ButtonVariant =
  "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon";
export function buttonVariants({
  variant = "default",
  size = "default",
  className = "",
}: {
  variant?: ButtonVariant | null;
  size?: ButtonSize | null;
  className?: string;
} = {}) {
  const variants: Record<ButtonVariant, string> = {
    default: "ui-button-primary",
    destructive: "ui-button-destructive",
    outline: "ui-button-outline",
    secondary: "ui-button-secondary",
    ghost: "ui-button-ghost",
    link: "ui-button-link",
  };
  return cn(
    "ui-button",
    variants[variant ?? "default"],
    `ui-button-${size ?? "default"}`,
    className,
  );
}
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, type = "button", ...props },
    ref,
  ) => {
    const Component = asChild ? Slot : "button";
    return (
      <Component
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        type={asChild ? undefined : type}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
