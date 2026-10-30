import * as React from "react";
import * as Primitive from "@radix-ui/react-dropdown-menu";
import { cn } from "../../lib/utils";
import "./menu.css";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, sideOffset = 6, collisionPadding = 12, ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Content ref={ref} sideOffset={sideOffset} collisionPadding={collisionPadding} className={cn("ui-menu-content", className)} {...props} />
  </Primitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <Primitive.Item ref={ref} className={cn("ui-menu-item", destructive && "ui-menu-item-destructive", className)} {...props} />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof Primitive.Label>,
  React.ComponentPropsWithoutRef<typeof Primitive.Label>
>(({ className, ...props }, ref) => <Primitive.Label ref={ref} className={cn("ui-menu-label", className)} {...props} />);
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof Primitive.Separator>,
  React.ComponentPropsWithoutRef<typeof Primitive.Separator>
>(({ className, ...props }, ref) => <Primitive.Separator ref={ref} className={cn("ui-menu-separator", className)} {...props} />);
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";
