import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/input';
import { Modal } from '../components/StudioUi';
import { captureCreatorSurvey, loadCreatorSurvey, type CreatorSurvey } from './creatorSurvey';
import { FEEDBACK_ELIGIBLE_EVENT, feedbackState, setFeedbackState } from './feedbackState';
import './creator-feedback.css';

/** One optional prompt after a successful save, deferred until the studio is idle. */
export function CreatorFeedback({ available, userId }: { available: boolean; userId: string | null }) {
  const surveyId = import.meta.env.VITE_POSTHOG_CREATOR_SURVEY_ID || '';
  const [revision, setRevision] = useState(0);
  const [survey, setSurvey] = useState<CreatorSurvey | null>(null);
  const [response, setResponse] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const update = () => setRevision(value => value + 1);
    window.addEventListener(FEEDBACK_ELIGIBLE_EVENT, update);
    return () => window.removeEventListener(FEEDBACK_ELIGIBLE_EVENT, update);
  }, []);
  useEffect(() => { setSurvey(null); setResponse(''); setSent(false); setError(''); }, [userId]);
  useEffect(() => {
    if (!surveyId || !userId || !available || survey || feedbackState(surveyId, userId) !== 'eligible') return;
    let cancelled = false;
    let timer = 0;
    const anotherSurfaceIsActive = () => document.visibilityState !== 'visible' || Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'));
    const showWhenIdle = async () => {
      if (cancelled) return;
      if (anotherSurfaceIsActive()) { timer = window.setTimeout(showWhenIdle, 1_000); return; }
      const next = await loadCreatorSurvey(surveyId, userId).catch(() => null);
      if (cancelled || !next || feedbackState(surveyId, userId) !== 'eligible') return;
      if (anotherSurfaceIsActive()) { timer = window.setTimeout(showWhenIdle, 1_000); return; }
      setFeedbackState(surveyId, userId, 'shown');
      setSurvey(next);
      void captureCreatorSurvey(next, 'shown', userId);
    };
    timer = window.setTimeout(showWhenIdle, 5_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [surveyId, userId, available, survey, revision]);

  function close() {
    if (!survey || !userId || pending) return;
    if (!sent) {
      setFeedbackState(surveyId, userId, 'dismissed');
      void captureCreatorSurvey(survey, 'dismissed', userId);
    }
    setSurvey(null);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!survey || !userId || !response.trim() || pending) return;
    setPending(true);
    setError('');
    try {
      if (!(await captureCreatorSurvey(survey, 'sent', userId, response))) {
        setError('Não foi possível enviar agora. Tente novamente ou feche esta pergunta.');
        return;
      }
      setFeedbackState(surveyId, userId, 'sent');
      setResponse('');
      setSent(true);
    } catch {
      setError('Não foi possível enviar agora. Tente novamente ou feche esta pergunta.');
    } finally { setPending(false); }
  }

  // A capture/export may begin from another control before this render. Hide
  // immediately; the optional prompt never blocks an active recording.
  if (!survey || !available || !userId) return null;
  return <Modal title={sent ? survey.thankYou : survey.question} description={sent ? 'Sua resposta ajuda a decidir os próximos passos do GravaSimples.' : survey.description} onClose={close} className="creator-feedback ph-no-capture">
    {sent ? <Button onClick={close}>Fechar</Button> : <form onSubmit={submit}>
      <label className="creator-feedback-label" htmlFor="creator-feedback-response">Seu comentário (opcional)</label>
      <Textarea id="creator-feedback-response" value={response} onChange={event => setResponse(event.target.value)} placeholder={survey.placeholder} maxLength={2_000} rows={4} autoFocus />
      {error && <p role="alert">{error}</p>}
      <div className="creator-feedback-actions"><Button type="button" variant="ghost" onClick={close} disabled={pending}>Agora não</Button><Button type="submit" disabled={pending || !response.trim()}>{pending ? 'Enviando…' : 'Enviar feedback'}</Button></div>
    </form>}
  </Modal>;
}
