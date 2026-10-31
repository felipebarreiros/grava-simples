import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/react';
import { useLocation } from 'react-router-dom';
import { identifyAnalytics, trackAuthenticatedSession, trackCreatorEvent, trackPage } from './client';

export function AnalyticsBridge() {
  const { isLoaded, userId, sessionId } = useAuth();
  const location = useLocation();
  const previousEntry = useRef('');
  useEffect(() => {
    if (!isLoaded) return;
    identifyAnalytics(userId ?? null);
    if (userId) trackAuthenticatedSession(sessionId);
    const entry = location.pathname === '/signup' || location.pathname.startsWith('/signup/') ? 'signup' : '';
    if (entry === 'signup' && previousEntry.current !== entry) trackCreatorEvent('signup_viewed');
    previousEntry.current = entry;
    trackPage();
  }, [isLoaded, userId, sessionId, location.pathname, location.hash]);
  return null;
}
