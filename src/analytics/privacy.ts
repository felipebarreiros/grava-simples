/** Stable route labels deliberately exclude Clerk tokens and local recording IDs. */
export function analyticsPage(pathname: string, hash = ''): string {
  if (pathname === '/') return 'home';
  for (const route of ['login', 'signup', 'password-recovery', 'logout']) {
    if (pathname === `/${route}` || pathname.startsWith(`/${route}/`)) return route;
  }
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    if (/^#project\/[^/]+\/recording\//.test(hash)) return 'recording';
    return hash.startsWith('#project/') ? 'studio' : 'projects';
  }
  return 'not-found';
}

export function analyticsUrl(value: string, origin: string): string {
  try {
    const url = new URL(value, origin);
    if (!['http:', 'https:'].includes(url.protocol)) return '[redacted]';
    // Keep asset filenames for symbolication, never their query parameters.
    if (url.origin === origin && /^\/assets\/[\w.-]+\.js$/.test(url.pathname)) return url.origin + url.pathname;
    if (url.origin !== origin) return url.origin;
    const page = analyticsPage(url.pathname, url.hash);
    return origin + (page === 'home' ? '/' : page === 'not-found' ? '/not-found' : `/` + page);
  } catch { return '[redacted]'; }
}

/** Defense in depth for SDK-generated URL, element and exception properties. */
export function sanitizeAnalytics(value: unknown, origin: string, key = '', exception = false): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeAnalytics(item, origin, key, exception));
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value)) {
      if (/referrer|referring_domain/i.test(name) || /\$el_text|attr__|\$input_value|\$exception_message|\$exception_stack_trace_raw|\$exception_source|\$search|\$title/.test(name)) continue;
      // Replay payloads have their own strict DOM/network masking configuration.
      if (name === '$snapshot_data') { clean[name] = entry; continue; }
      if (name === 'value' && exception) { clean[name] = 'Application error (message redacted)'; continue; }
      if (name === 'vars' || name === 'pre_context' || name === 'post_context' || name === 'context_line') continue;
      clean[name] = sanitizeAnalytics(entry, origin, name, exception || name === '$exception_list');
    }
    return clean;
  }
  if (typeof value === 'string' && /url|href|filename|pathname/i.test(key)) return analyticsUrl(value, origin);
  return value;
}
