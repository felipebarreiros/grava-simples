import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "../../lib/utils";
import "./kit.css";
/** Official shadcn/ui Radix Switch, with equivalent token-based CSS classes. */
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn("ui-switch", className)}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb className="ui-switch-thumb" />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;
