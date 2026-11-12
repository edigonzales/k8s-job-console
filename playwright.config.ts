import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  workers: 1,
  timeout: 150_000,
  use: { baseURL: 'http://127.0.0.1:4466', trace: 'off' },
  outputDir: 'build/playwright',
});
