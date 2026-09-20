import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Every test file mutates process.env and the module-scope hydration state, so files run
    // one at a time. resetHydration() in a beforeEach handles the within-file case.
    fileParallelism: false,
  },
})
