import { initializeAnalytics } from './client';

export interface CreatorSurvey {
  id: string; questionId: string; question: string; description: string;
  iteration: number | null; placeholder: string; thankYou: string;
}

export async function loadCreatorSurvey(surveyId: string, userId: string): Promise<CreatorSurvey | null> {
  const client = await initializeAnalytics();
  if (!client || client.has_opted_out_capturing() || client.get_distinct_id() !== userId) return null;
  return new Promise(resolve => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (value: CreatorSurvey | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 8_000);
    // Matching updates after definitions and native survey eligibility flags
    // load. An initially empty list must not suppress a newly eligible user.
    unsubscribe = client.onActiveMatchingSurveysChanged(surveys => {
      if (client.get_distinct_id() !== userId) { finish(null); return; }
      const survey = surveys.find(item => item.id === surveyId && item.type === 'api');
      const question = survey?.questions[0];
      if (!survey || !question || question.type !== 'open' || !question.id) return;
      finish({
        id: survey.id, questionId: question.id, question: question.question,
        description: question.description || 'Sua resposta ajuda a melhorar o GravaSimples.',
        iteration: survey.current_iteration ?? null,
        placeholder: survey.appearance?.placeholder || 'Conte o que faltou para você…',
        thankYou: survey.appearance?.thankYouMessageHeader || 'Obrigado pelo feedback!',
      });
    });
    if (settled) unsubscribe();
    else client.getSurveys(() => {}, true);
  });
}

export async function captureCreatorSurvey(survey: CreatorSurvey, action: 'shown' | 'dismissed' | 'sent', userId: string, response = ''): Promise<boolean> {
  const client = await initializeAnalytics();
  if (!client || client.has_opted_out_capturing() || client.get_distinct_id() !== userId) return false;
  const properties: Record<string, unknown> = { $survey_id: survey.id, $survey_iteration: survey.iteration };
  if (action === 'sent') {
    // Survey responses are collected only after an explicit submit. They never
    // enter operational logs, errors or creator-event properties.
    properties[`$survey_response_${survey.questionId}`] = response.trim().slice(0, 2_000);
    properties.$survey_submission_id = crypto.randomUUID();
    properties.$survey_completed = true;
    properties.$survey_questions = [{ id: survey.questionId, question: survey.question }];
  }
  try { return Boolean(client.capture(`survey ${action}`, properties)); } catch { return false; }
}
