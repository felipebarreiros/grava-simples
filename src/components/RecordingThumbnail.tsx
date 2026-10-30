import { useEffect, useRef, useState } from 'react';
import { FileVideo, LoaderCircle } from 'lucide-react';
import { ensureProjectTakeThumbnail, type ProjectTake } from '../projects/store';
import './RecordingThumbnail.css';

/** A still from this take; older recordings are backfilled only near the viewport. */
export function RecordingThumbnail({ take }: { take: ProjectTake }) {
  const container = useRef<HTMLDivElement>(null);
  const [thumbnail, setThumbnail] = useState(take.thumbnail);
  const [status, setStatus] = useState<'waiting' | 'loading' | 'ready' | 'unavailable'>(take.thumbnail ? 'ready' : 'waiting');

  useEffect(() => {
    setThumbnail(take.thumbnail);
    if (take.thumbnail) { setStatus('ready'); return; }
    setStatus('waiting');
    const controller = new AbortController();
    const load = () => {
      if (controller.signal.aborted) return;
      setStatus('loading');
      void ensureProjectTakeThumbnail(take, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        setThumbnail(result.thumbnail);
        setStatus('ready');
      }).catch(() => {
        if (!controller.signal.aborted) setStatus('unavailable');
      });
    };
    let observer: IntersectionObserver | undefined;
    if (container.current && 'IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); load(); }
      }, { rootMargin: '200px' });
      observer.observe(container.current);
    } else load();
    return () => { observer?.disconnect(); controller.abort(); };
    // A rename should not cancel/restart decoding of the same recording.
  }, [take.id, take.thumbnail]);

  return (
    <div className="recording-thumbnail" ref={container} data-status={status}>
      {thumbnail ? <img src={thumbnail} alt={`Prévia de ${take.name}`} loading="lazy" /> : (
        <div className="recording-thumbnail-status">
          {status !== 'unavailable' && <LoaderCircle size={18} className="recording-thumbnail-spinner" aria-hidden="true" />}
          <span>{status === 'unavailable' ? 'Prévia indisponível' : 'Preparando prévia'}</span>
        </div>
      )}
      <div className="recording-thumbnail-badge" aria-hidden="true"><FileVideo size={14} /></div>
    </div>
  );
}
