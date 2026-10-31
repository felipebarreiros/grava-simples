import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

// Never require admin credentials for local development or unconfigured builds.
if (process.env.VERCEL === '1' && process.env.POSTHOG_CLI_PROJECT_ID &&
    (process.env.POSTHOG_CLI_TOKEN || process.env.POSTHOG_CLI_API_KEY)) {
  const require = createRequire(import.meta.url);
  const cli = resolve(dirname(require.resolve('@posthog/cli/package.json')), 'run-posthog-cli.js');
  execFileSync(process.execPath, [cli, 'sourcemap', 'process', '--directory', 'dist/assets',
    '--release-name', 'grava-simples', '--release-version', process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    '--delete-after'], { stdio: 'inherit', timeout: 120_000 });
}
