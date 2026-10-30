import { useRef } from "react";
import * as Primitive from "@radix-ui/react-alert-dialog";
import { Button } from "./button";
import "./alert-dialog.css";

export function AlertDialog({
  title,
  description,
  actionLabel,
  pending = false,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  actionLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  return (
    <Primitive.Root open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <Primitive.Portal>
        <Primitive.Overlay className="ui-alert-overlay" />
        <Primitive.Content
          className="ui-alert-content"
          onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
          }}
        >
          <Primitive.Title className="ui-alert-title">{title}</Primitive.Title>
          <Primitive.Description className="ui-alert-description">{description}</Primitive.Description>
          <div className="ui-alert-actions">
            <Primitive.Cancel asChild><Button variant="outline" disabled={pending}>Cancelar</Button></Primitive.Cancel>
            <Button variant="destructive" onClick={onConfirm} disabled={pending}>{pending ? "Excluindo…" : actionLabel}</Button>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
