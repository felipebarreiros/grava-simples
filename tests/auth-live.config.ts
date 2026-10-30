import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../playwright.config';

export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: 'auth-live.spec.ts',
  outputDir: fileURLToPath(new URL('../.context/results/auth-live-artifacts', import.meta.url)),
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../.context/results/auth-live-playwright-report.json', import.meta.url)) }]],
  use: {
    ...base.use,
    baseURL: process.env.CLERK_TEST_BASE_URL ?? process.env.TEST_BASE_URL ?? 'http://127.0.0.1:5174',
    trace: 'off', video: 'off', screenshot: 'off',
  },
});
