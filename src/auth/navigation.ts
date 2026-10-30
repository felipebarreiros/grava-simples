type PageLocation = Pick<Location, 'pathname' | 'search' | 'hash'>;

type RouterNavigate = (to: string, options: { replace: boolean }) => unknown;

export type ClerkRouterMetadata = {
  windowNavigate?: (to: URL | string) => void;
  __internal_metadata?: { navigationType?: string };
};

type NavigationBrowser = {
  location: Pick<Location, 'href' | 'assign' | 'replace'>;
};

/**
 * Return URLs are built only after Clerk has resolved the session. Its startup
 * uses native replaceState to remove transport data, which does not update
 * React Router's useLocation snapshot. Never copy that stale data into login.
 */
export function studioReturnUrl(location: PageLocation): string {
  const params = new URLSearchParams(location.search);
  let changed = false;
  for (const name of [...params.keys()]) {
    if (name.startsWith('__clerk_') || name === 'suffixed_cookies') {
      params.delete(name);
      changed = true;
    }
  }
  const search = changed ? (params.size ? `?${params.toString()}` : '') : location.search;
  return location.pathname + search + location.hash;
}

/** Only restore application destinations on this origin after authentication. */
export function studioRedirectUrl(search: string, origin: string): string {
  const value = new URLSearchParams(search).get('redirect_url');
  if (!value) return '/app';
  try {
    const url = new URL(value, origin);
    if (url.origin === origin && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
      return studioReturnUrl(url);
    }
  } catch { /* A malformed return destination falls back to the studio. */ }
  return '/app';
}

/**
 * Normal Clerk UI steps use the SPA router. A newly issued handshake or dev
 * browser token must start a document load so Clerk can process it during
 * initialization; navigating within an already-loaded SPA would strand it.
 */
export function createClerkRouterNavigation(
  navigate: RouterNavigate,
  browser: NavigationBrowser = window,
) {
  const route = (to: string, replace: boolean, metadata?: ClerkRouterMetadata) => {
    let current: URL;
    let target: URL;
    try {
      current = new URL(browser.location.href);
      target = new URL(to, current);
    } catch { return; }

    // Clerk validates its own redirect protocols before invoking the router.
    // Delegate any explicitly allowed custom protocol back to that validator.
    if (!['http:', 'https:'].includes(target.protocol)) {
      return metadata?.windowNavigate?.(target);
    }
    const hasTransport = ['__clerk_handshake', '__clerk_handshake_nonce', '__clerk_db_jwt']
      .some(name => target.searchParams.has(name));
    const requiresDocument = target.origin !== current.origin || hasTransport ||
      metadata?.__internal_metadata?.navigationType === 'window';

    if (requiresDocument) {
      if (metadata?.windowNavigate) return metadata.windowNavigate(target);
      return replace ? browser.location.replace(target.href) : browser.location.assign(target.href);
    }
    return navigate(target.pathname + target.search + target.hash, { replace });
  };

  return {
    push: (to: string, metadata?: ClerkRouterMetadata) => route(to, false, metadata),
    replace: (to: string, metadata?: ClerkRouterMetadata) => route(to, true, metadata),
  };
}
