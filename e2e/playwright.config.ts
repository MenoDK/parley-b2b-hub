import { defineConfig } from '@playwright/test';

// Point E2E_BASE_URL at the running demo. It must be a secure origin (localhost or https): the lab signs webhooks
// with WebCrypto, which browsers only expose there. `make e2e` arranges that by sharing the API's network.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8000';

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // both services keep state in their databases, so tests run one at a time
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
});
