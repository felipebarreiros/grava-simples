import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, type NavigateOptions, type To } from 'react-router-dom';

/**
 * Clerk waits for this promise before publishing the newly active session.
 * BrowserRouter's navigate() returns void before React commits the new route;
 * resolving at that point can make the old sign-in page redirect a second time.
 * Keep this hook in the persistent provider, not inside an authentication page.
 */
export function useAwaitableNavigate() {
  const navigate = useNavigate();
  const location = useLocation();
  const pending = useRef(new Set<() => void>());

  const resolvePending = useCallback(() => {
    const callbacks = [...pending.current];
    pending.current.clear();
    callbacks.forEach(resolve => resolve());
  }, []);

  // React Router creates a new location even for same-URL navigation. Resolve
  // all settled requests together so a superseded navigation cannot hang Clerk.
  useEffect(resolvePending, [location, resolvePending]);
  useEffect(() => resolvePending, [resolvePending]);

  return useCallback((to: To, options?: NavigateOptions): Promise<void> => {
    return new Promise((resolve, reject) => {
      pending.current.add(resolve);
      try {
        const result = navigate(to, options);
        void Promise.resolve(result).catch(error => {
          pending.current.delete(resolve);
          reject(error);
        });
      } catch (error) {
        pending.current.delete(resolve);
        reject(error);
      }
    });
  }, [navigate]);
}
