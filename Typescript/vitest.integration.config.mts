import { defineConfig } from 'vitest/config'

// The provider pads an unhandled startup failure to five seconds, so these are slower than the
// unit run and kept out of it. See test/provider-contract.integration.test.ts for why they exist.
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
  },
})
