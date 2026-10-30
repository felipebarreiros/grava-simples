import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: Number(process.env.RECORDING_SOAK_SECONDS ?? 0) * 1000 + 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['json', { outputFile: '.context/results/playwright-report.json' }]],
  outputDir: '.context/results/playwright-artifacts',
  use: {
    baseURL: process.env.TEST_BASE_URL ?? 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
    trace: process.env.RECORDING_TRACE === '1' ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(process.env.CHROME_DISABLE_GPU === '1' ? ['--disable-gpu'] : [])],
    },
  },
})
