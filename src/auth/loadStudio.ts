const RECOVERY_KEY = 'grava-studio-chunk-recovery';
const RECOVERY_INTERVAL_MS = 60_000;

/** A tab open during deployment can still reference a retired Vite chunk. */
export async function loadStudio() {
  try {
    const module = await import('../App');
    try { sessionStorage.removeItem(RECOVERY_KEY); } catch { /* Storage may be disabled. */ }
    return module;
  } catch (error) {
    const importFailure = error instanceof Error && /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(error.message);
    if (import.meta.env.PROD && importFailure && navigator.onLine) {
      try {
        const previous = Number(sessionStorage.getItem(RECOVERY_KEY) ?? 0);
        if (Date.now() - previous > RECOVERY_INTERVAL_MS) {
          // Retry once with the current HTML/module graph. Keep the current
          // project fragment and prevent a loop if the host stays unavailable.
          sessionStorage.setItem(RECOVERY_KEY, String(Date.now()));
          window.location.reload();
          return new Promise<never>(() => {});
        }
      } catch { /* Fall back to the visible retry screen when storage is blocked. */ }
    }
    throw error;
  }
}
