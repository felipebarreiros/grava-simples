import {
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "./ui/dialog";
import { Camera, Monitor, X, ZoomIn } from "lucide-react";
import type { StudioLayout } from "../media/types";

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </Button>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
}) {
  // These dialogs are conditionally mounted, so there is no Radix Trigger to
  // restore focus to. Capture the action before an autoFocus input commits.
  const previous = useRef(document.activeElement as HTMLElement | null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className={`studio-modal ${wide ? "wide" : ""} ${className}`}
            {...(!description ? { "aria-describedby": undefined } : {})}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const nextDialog = document.querySelector(
                '[role="dialog"], [role="alertdialog"]',
              );
              if (
                previous.current?.isConnected &&
                (!nextDialog || nextDialog.contains(previous.current))
              )
                previous.current.focus({ preventScroll: true });
            }}
          >
            <header className="modal-header">
              <div>
                <DialogTitle>{title}</DialogTitle>
                {description && (
                  <DialogDescription>{description}</DialogDescription>
                )}
              </div>
              <DialogClose asChild>
                <IconButton label="Fechar">
                  <X size={18} />
                </IconButton>
              </DialogClose>
            </header>
            <div className="modal-content">{children}</div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  );
}

export function SceneThumbnail({
  layout,
  large = false,
}: {
  layout: StudioLayout;
  large?: boolean;
}) {
  return (
    <div
      className={`scene-thumbnail thumb-${layout} ${large ? "large" : ""}`}
      aria-hidden="true"
    >
      {(layout === "screen" || layout === "screen-3d") && (
        <div className="thumb-screen">
          <Monitor size={large ? 22 : 16} />
          <i />
          <i />
          <i />
        </div>
      )}
      <div className="thumb-camera">
        <Camera size={large ? 25 : 18} />
      </div>
      {layout === "camera-zoom" && (
        <span className="thumb-zoom">
          <ZoomIn size={11} /> 1.4×
        </span>
      )}
    </div>
  );
}

export function AudioMeter({
  decibels,
  muted,
}: {
  decibels: number;
  muted: boolean;
}) {
  const level = muted
    ? 0
    : Math.max(
        0,
        Math.min(
          100,
          (((Number.isFinite(decibels) ? decibels : -100) + 60) / 60) * 100,
        ),
      );
  return (
    <div
      className="meter-block"
      role="meter"
      aria-label="Nível do microfone"
      aria-valuemin={-60}
      aria-valuemax={0}
      aria-valuenow={muted ? -60 : Math.max(-60, Math.min(0, decibels))}
    >
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${level}%` }} />
      </div>
      <div className="meter-ticks">
        <span>−60</span>
        <span>−40</span>
        <span>−20</span>
        <span>−6</span>
        <span>0 dB</span>
      </div>
    </div>
  );
}
