import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // The integration run drives the real provider and takes seconds, not milliseconds.
    // `npm run test:integration`, or `make test-integration-ts`.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    // Every test file mutates process.env and the module-scope hydration state, so files run
    // one at a time. resetHydration() in a beforeEach handles the within-file case.
    fileParallelism: false,
  },
})
