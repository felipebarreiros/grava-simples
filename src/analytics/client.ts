import type { PostHog } from 'posthog-js';
import { analyticsPage, analyticsUrl, sanitizeAnalytics } from './privacy';
import { creatorProperties, type CreatorEvent, type EventProperties } from './eventProperties';
import { markRecordingFeedbackEligible } from './feedbackState';

let loading: Promise<PostHog | null> | undefined;
let lastUser: string | null | undefined;
let lastPage = '';
const authenticatedSessions = new Set<string>();

export function initializeAnalytics(): Promise<PostHog | null> {
  if (loading) return loading;
  const key = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;
  const host = import.meta.env.VITE_POSTHOG_HOST;
  if (!key || !host || (!import.meta.env.PROD && import.meta.env.VITE_POSTHOG_ENABLED !== 'true')) {
    return Promise.resolve(null);
  }
  loading = import('posthog-js/full/no-external').then(({ default: posthog }) => {
    const origin = window.location.origin;
    posthog.init(key, {
      api_host: host,
      ui_host: 'https://us.posthog.com',
      defaults: '2026-08-30',
      person_profiles: 'identified_only',
      persistence: 'localStorage',
      cross_subdomain_cookie: false,
      respect_dnt: true,
      save_referrer: false,
      save_campaign_params: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_capture_url_hashes: true,
      autocapture: { capture_copied_text: false },
      mask_all_text: true,
      mask_all_element_attributes: true,
      capture_exceptions: true,
      capture_performance: true,
      capture_heatmaps: true,
      enable_recording_console_log: false,
      tracing_headers: [window.location.hostname],
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '*',
        maskAllElementAttributes: true,
        blockSelector: 'video, audio, canvas, img, image, iframe, [style*="url("], input[type="file"], input[type="hidden"], .cl-rootBox',
        recordCrossOriginIframes: false,
        recordHeaders: false,
        recordBody: false,
        captureCanvas: { recordCanvas: false },
        captureJsonLd: false,
        maskCapturedNetworkRequestFn: request => ({ ...request, name: analyticsUrl(request.name, origin) }),
      },
      logs: {
        serviceName: 'grava-simples-web',
        environment: import.meta.env.VITE_DEPLOYMENT_ENVIRONMENT || 'production',
        captureConsoleLogs: false,
        maxLogsPerInterval: 30,
        beforeSend: record => ({ ...record, attributes: {
          ...sanitizeAnalytics(record.attributes, origin) as Record<string, string>,
          'url.full': analyticsUrl(window.location.href, origin),
        } }),
      },
      before_send: event => {
        if (event) {
          event.properties = sanitizeAnalytics(event.properties, origin) as typeof event.properties;
          if (event.$set) event.$set = sanitizeAnalytics(event.$set, origin) as typeof event.$set;
          if (event.$set_once) event.$set_once = sanitizeAnalytics(event.$set_once, origin) as typeof event.$set_once;
        }
        return event;
      },
    });
    posthog.logger.info('Application analytics initialized');
    return posthog;
  }).catch(() => null); // Telemetry must never prevent recording or authentication.
  return loading;
}

export function identifyAnalytics(userId: string | null) {
  void initializeAnalytics().then(client => {
    if (!client) return;
    const previous = lastUser ?? (client._isIdentified() ? client.get_distinct_id() : null);
    if (previous && previous !== userId) client.reset();
    if (userId && userId !== lastUser) client.identify(userId);
    lastUser = userId;
  });
}

export function trackPage(visiblePage?: 'studio' | 'projects' | 'recording' | 'recordings') {
  const page = visiblePage ?? analyticsPage(window.location.pathname, window.location.hash);
  if (lastPage === page) return;
  lastPage = page;
  void initializeAnalytics().then(client => client?.capture('$pageview', {
    page, $current_url: analyticsUrl(window.location.href, window.location.origin),
  }));
}

export function trackCreatorEvent(event: CreatorEvent, properties: EventProperties = {}, expectedUserId?: string) {
  void initializeAnalytics().then(client => {
    if (!client || client.has_opted_out_capturing()) return;
    if (expectedUserId && client.get_distinct_id() !== expectedUserId) return;
    const safe = creatorProperties(properties);
    client.capture(event, safe);
    if (event.endsWith('_failed')) client.logger.error(event, safe);
    else client.logger.info(event, safe);
    if (event === 'recording_saved' && safe.outcome === 'complete' && lastUser)
      markRecordingFeedbackEligible(import.meta.env.VITE_POSTHOG_CREATOR_SURVEY_ID ?? '', lastUser);
  });
}

export function trackAuthenticatedSession(sessionId: string | null | undefined) {
  if (!sessionId || authenticatedSessions.has(sessionId)) return;
  const key = `grava-analytics-authenticated:${sessionId}`;
  try { if (sessionStorage.getItem(key)) { authenticatedSessions.add(sessionId); return; } } catch { /* Session-only fallback below. */ }
  void initializeAnalytics().then(client => {
    if (!client || client.has_opted_out_capturing() || authenticatedSessions.has(sessionId)) return;
    if (!client.capture('account_authenticated')) return;
    authenticatedSessions.add(sessionId);
    try { sessionStorage.setItem(key, '1'); } catch { /* In-memory deduplication remains active. */ }
  });
}

export function reportApplicationError(error: unknown, operation: 'authentication' | 'studio' | 'recording' | 'transcription') {
  void initializeAnalytics().then(client => {
    // Retain the original stack for source maps; redact messages containing creator content.
    const safe = new Error(`Application error during ${operation}`);
    if (error instanceof Error) safe.stack = error.stack?.replace(/^.*\n/, `${safe.message}\n`);
    client?.captureException(safe, { operation });
    client?.logger.error('Application operation failed', { operation });
  });
}
