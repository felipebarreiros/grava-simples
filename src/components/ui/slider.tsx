import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "../../lib/utils";
import "./kit.css";
export interface SliderProps extends React.ComponentPropsWithoutRef<
  typeof SliderPrimitive.Root
> {
  label?: string;
  "data-testid"?: string;
}
/** Official shadcn/ui Radix Slider composition; keyboard focus stays on its thumb. */
export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>(({ className, label, "data-testid": testId, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("ui-slider", className)}
    {...props}
  >
    <SliderPrimitive.Track className="ui-slider-track">
      <SliderPrimitive.Range className="ui-slider-range" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      className="ui-slider-thumb"
      aria-label={label ?? props["aria-label"]}
      data-testid={testId}
    />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;
