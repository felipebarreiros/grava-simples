import * as React from "react";
import * as Primitive from "@radix-ui/react-context-menu";
import { cn } from "../../lib/utils";
import "./menu.css";

export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;

export const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(({ className, collisionPadding = 12, ...props }, ref) => (
  <Primitive.Portal>
    <Primitive.Content ref={ref} collisionPadding={collisionPadding} className={cn("ui-menu-content", className)} {...props} />
  </Primitive.Portal>
));
ContextMenuContent.displayName = "ContextMenuContent";

export const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <Primitive.Item ref={ref} className={cn("ui-menu-item", destructive && "ui-menu-item-destructive", className)} {...props} />
));
ContextMenuItem.displayName = "ContextMenuItem";

export const ContextMenuLabel = React.forwardRef<
  React.ComponentRef<typeof Primitive.Label>,
  React.ComponentPropsWithoutRef<typeof Primitive.Label>
>(({ className, ...props }, ref) => <Primitive.Label ref={ref} className={cn("ui-menu-label", className)} {...props} />);
ContextMenuLabel.displayName = "ContextMenuLabel";

export const ContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof Primitive.Separator>,
  React.ComponentPropsWithoutRef<typeof Primitive.Separator>
>(({ className, ...props }, ref) => <Primitive.Separator ref={ref} className={cn("ui-menu-separator", className)} {...props} />);
ContextMenuSeparator.displayName = "ContextMenuSeparator";
