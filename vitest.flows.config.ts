import { defineConfig } from 'vitest/config';

// `npm run test:flows`: the steps of a run against real MongoDB, a real
// queue and the stand-in. Needs `docker compose up -d`. It uses its own
// database, queue and stand-in port, so it never touches a running demo.
export default defineConfig({
  test: {
    include: ['tests/flows/**/*.test.ts'],
    globalSetup: ['tests/flows/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      PROVIDER: 'stand-in', // whatever the shell holds, these tests never reach Oncade
      MONGO_DB: 'payout_runs_test',
      QUEUE_NAME: 'payout-runs-test',
      STAND_IN_URL: 'http://127.0.0.1:3311',
      BATCH_LEASE_MS: '300',
      ONCADE_TIMEOUT_MS: '2000',
      BREAKER_THRESHOLD: '1000',
    },
  },
});
