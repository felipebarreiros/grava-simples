import * as React from "react";
import * as Primitive from "@radix-ui/react-toggle-group";
import { buttonVariants, type ButtonProps } from "./button";
import { cn } from "../../lib/utils";
import "./toggle-group.css";

export const ToggleGroup = Primitive.Root;

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item> & Pick<ButtonProps, "variant" | "size">
>(({ className, variant = "ghost", size = "icon", ...props }, ref) => (
  <Primitive.Item
    ref={ref}
    className={cn(buttonVariants({ variant, size }), "ui-toggle-group-item", className)}
    {...props}
  />
));
ToggleGroupItem.displayName = "ToggleGroupItem";
