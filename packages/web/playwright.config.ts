import { defineConfig, devices } from "@playwright/test"

/**
 * End-to-end configuration.
 *
 * The suite runs against a **built** app rather than the dev server, and that
 * is the point of an E2E gate: the dev server has different bundling, different
 * error overlays and no route-segment caching, so a bug that only appears in a
 * production build is exactly the one this is here to catch — and the one a
 * dev-server suite would miss.
 *
 * Two environment variables shape what runs:
 *
 *   `E2E_BASE_URL`   — an already-running deployment (a staging environment).
 *                      When set, no server is started here.
 *   `SCE_API_KEY`    — a key for the API, used to seed fixtures over HTTP.
 *                      Without it the specs that need real data skip
 *                      themselves rather than failing, so a contributor with no
 *                      backend still gets a useful run.
 *
 * Nothing here mocks the API. An E2E suite whose backend is a stub tests the
 * frontend's opinion of the contract, which is the half already covered by
 * `hc<AppType>()` and the Zod parsers.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000"
const external = process.env.E2E_BASE_URL !== undefined

export default defineConfig({
  testDir: "./e2e",
  /**
   * `.e2e.ts`, not `.spec.ts`.
   *
   * Bun's test runner claims `*.spec.ts` as well as `*.test.ts`, so a Playwright
   * spec under the default name is picked up by `bun test` at the repository
   * root and fails with a confusing "did not expect test.describe() to be called
   * here". Giving the two runners disjoint extensions means each claims only its
   * own files, and `bun test` stays a single green command.
   */
  testMatch: "**/*.e2e.ts",
  // A failing E2E is usually a real failure; a *flaky* one is usually a missing
  // await. Retries in CI only, so flakiness stays visible locally.
  retries: process.env.CI === undefined ? 0 : 2,
  workers: process.env.CI === undefined ? undefined : 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? "list" : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL,
    // Kept only for failures: a trace per passing test is gigabytes of CI
    // artefact nobody opens.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The composer and the run view are the two places a phone is genuinely
    // likely to be used — reading a shared answer even more so.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],

  ...(external
    ? {}
    : {
        webServer: {
          command: "bun run build && bun run start",
          url: baseURL,
          reuseExistingServer: process.env.CI === undefined,
          timeout: 180_000,
        },
      }),
})
