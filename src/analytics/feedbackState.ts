export type FeedbackState = 'eligible' | 'shown' | 'dismissed' | 'sent';
export const FEEDBACK_ELIGIBLE_EVENT = 'grava:creator-feedback-eligible';
const memory = new Map<string, FeedbackState>();
function key(surveyId: string, userId: string) { return `grava-creator-feedback:${surveyId}:${userId}`; }

export function feedbackState(surveyId: string, userId: string): FeedbackState | null {
  const storageKey = key(surveyId, userId);
  try {
    const state = localStorage.getItem(storageKey);
    if (['eligible', 'shown', 'dismissed', 'sent'].includes(state ?? '')) return state as FeedbackState;
  } catch { /* The in-memory marker still prevents repeat prompts this visit. */ }
  return memory.get(storageKey) ?? null;
}

export function setFeedbackState(surveyId: string, userId: string, state: FeedbackState) {
  const storageKey = key(surveyId, userId);
  memory.set(storageKey, state);
  try { localStorage.setItem(storageKey, state); } catch { /* Feedback remains optional. */ }
}

export function markRecordingFeedbackEligible(surveyId: string, userId: string) {
  if (!surveyId || !userId || feedbackState(surveyId, userId)) return;
  setFeedbackState(surveyId, userId, 'eligible');
  window.dispatchEvent(new Event(FEEDBACK_ELIGIBLE_EVENT));
}
