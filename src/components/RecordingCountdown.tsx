import { useEffect, useRef } from 'react';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from './ui/dialog';
import './RecordingCountdown.css';

/** Displayed outside the capture canvases: the countdown is never recorded. */
export function RecordingCountdown({ seconds, onCancel }: { seconds: number | null; onCancel: () => void }) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const lastSeconds = useRef(3);
  useEffect(() => { if (seconds !== null) lastSeconds.current = seconds; }, [seconds]);
  const digit = seconds ?? lastSeconds.current;

  return <Dialog open={seconds !== null} onOpenChange={open => { if (!open) onCancel(); }}>
    <DialogPortal>
      <DialogOverlay className="modal-backdrop recording-countdown-backdrop" />
      <DialogContent
        className="studio-modal recording-countdown"
        aria-describedby={undefined}
        onOpenAutoFocus={() => { previousFocus.current = document.activeElement as HTMLElement | null; }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          const nextDialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
          if (previousFocus.current?.isConnected && (!nextDialog || nextDialog.contains(previousFocus.current)))
            previousFocus.current.focus({ preventScroll: true });
        }}
      >
        <DialogTitle className="recording-countdown-title">A gravação começa em</DialogTitle>
        <div className="recording-countdown-number" role="status" aria-live="assertive" aria-atomic="true" data-testid="recording-countdown">
          <span className="recording-countdown-sr">Gravação em {digit}</span>
          <span key={digit} className="recording-countdown-digits" aria-hidden="true">
            {digit < 3 && <span className="recording-countdown-previous">{digit + 1}</span>}
            <span className="recording-countdown-current">{digit}</span>
          </span>
        </div>
        <Button variant="secondary" disabled={seconds === null} onClick={onCancel}>Cancelar</Button>
      </DialogContent>
    </DialogPortal>
  </Dialog>;
}
