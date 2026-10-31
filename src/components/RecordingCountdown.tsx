import { Modal } from './StudioUi';
import { Button } from './ui/button';
import './RecordingCountdown.css';

/** Displayed outside the capture canvases: the countdown is never recorded. */
export function RecordingCountdown({ seconds, onCancel }: { seconds: number; onCancel: () => void }) {
  return <Modal title="A gravação começa em" onClose={onCancel} className="recording-countdown">
    <div className="recording-countdown-number" role="status" aria-live="assertive" aria-atomic="true" data-testid="recording-countdown">
      <span className="recording-countdown-sr">Gravação em </span>{seconds}
    </div>
    <Button variant="secondary" onClick={onCancel}>Cancelar</Button>
  </Modal>;
}
