import { useEffect } from 'react';
import { useAuth } from '@clerk/react';
import { useLocation } from 'react-router-dom';
import { identifyAnalytics, trackPage } from './client';

export function AnalyticsBridge() {
  const { isLoaded, userId } = useAuth();
  const location = useLocation();
  useEffect(() => {
    if (!isLoaded) return;
    identifyAnalytics(userId ?? null);
    trackPage();
  }, [isLoaded, userId, location.pathname, location.hash]);
  return null;
}
