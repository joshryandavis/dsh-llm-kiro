import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// Both tsconfig projects are registered explicitly: this package's tsconfig
// (paths into the deepseek-harness checkout for importers under this
// package) and the checkout's base tsconfig (for importers inside the
// checkout itself — vendored cordis and the dsh packages).
export default defineConfig({
  plugins: [
    tsconfigPaths({
      projects: ['tsconfig.json', '../.context/deepseek-harness/tsconfig.base.json'],
    }),
  ],
  test: {
    testTimeout: 10_000,
  },
})
