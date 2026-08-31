import { expect, test } from "./fixtures"

/**
 * The signed-in flows.
 *
 * These need a real Clerk session, which needs credentials this repository does
 * not and must not contain. Rather than mock the identity provider — which
 * would test a fiction — the suite reads a test account from the environment
 * and skips itself when there is not one.
 *
 * Set these in CI (Clerk's own test-mode user is fine):
 *
 *   E2E_USER_EMAIL, E2E_USER_PASSWORD
 *
 * The plan's exit criterion for this phase — sign up, ask, watch it stream,
 * share it, see it billed — is what this file walks, in order.
 */

const EMAIL = process.env.E2E_USER_EMAIL ?? null
const PASSWORD = process.env.E2E_USER_PASSWORD ?? null
const configured = EMAIL !== null && PASSWORD !== null

test.describe("signed in", () => {
  test.skip(!configured, "needs E2E_USER_EMAIL and E2E_USER_PASSWORD")

  test.beforeEach(async ({ page }) => {
    await page.goto("/sign-in")
    await page.getByLabel(/email/i).fill(EMAIL ?? "")
    await page.getByRole("button", { name: /continue/i }).click()
    await page.getByLabel(/password/i).fill(PASSWORD ?? "")
    await page.getByRole("button", { name: /continue/i }).click()
    await page.waitForURL(/\/(ask|runs)/)
  })

  test("the composer shows what a run will cost before it is started", async ({ page }) => {
    await page.goto("/ask")

    await expect(page.getByRole("heading", { name: /ask the panel/i })).toBeVisible()
    await expect(page.getByText(/estimated cost/i)).toBeVisible()

    const composer = page.getByRole("textbox")
    await composer.fill("What is the CAP theorem?")

    // The estimate has to react to the prompt: a figure that never moves is a
    // figure nobody believes.
    await expect(page.getByText(/about \$|at least \$|cost unknown/i)).toBeVisible()
  })

  test("a run streams, then settles into an answer", async ({ page }) => {
    await page.goto("/ask")
    await page.getByRole("textbox").fill(`E2E: name three primary colours (${Date.now()})`)
    await page.getByRole("button", { name: /ask the panel/i }).click()

    await page.waitForURL(/\/runs\/[a-z0-9]+/i)

    // The live indicator is what tells a user the page is not simply stuck.
    await expect(page.getByText(/live|connecting/i).first()).toBeVisible()

    // Then the answer, within the run deadline.
    await expect(page.getByRole("tab", { name: /answer/i })).toBeVisible()
    await expect(page.getByRole("heading", { name: /^answer$/i })).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText(/where they agreed/i)).toBeVisible()
  })

  test("history filters are in the URL, so the back button undoes them", async ({ page }) => {
    await page.goto("/runs")
    await page.getByRole("searchbox").fill("colours")
    await page.getByRole("button", { name: /^search$/i }).click()

    await expect(page).toHaveURL(/[?&]q=colours/)

    await page.goBack()
    await expect(page).not.toHaveURL(/[?&]q=colours/)
  })

  test("an answer can be published and then revoked", async ({ page }) => {
    await page.goto("/runs")
    await page.getByRole("link").filter({ hasText: /E2E:/ }).first().click()

    await page.getByRole("button", { name: /^share$/i }).click()
    await expect(page.getByRole("dialog")).toBeVisible()

    await page.getByRole("button", { name: /create a link/i }).click()
    await expect(page.getByText(/\/share\//)).toBeVisible()

    await page.getByRole("button", { name: /revoke/i }).first().click()
    await expect(page.getByText(/revoked/i).first()).toBeVisible()
  })

  test("usage reports what has been spent, against the plan's ceilings", async ({ page }) => {
    await page.goto("/usage")

    await expect(page.getByRole("heading", { name: /^usage$/i })).toBeVisible()
    await expect(page.getByText(/runs this month/i)).toBeVisible()
    await expect(page.getByRole("table")).toBeVisible()
  })

  test("the operations console is not reachable by an ordinary account", async ({ page }) => {
    const response = await page.goto("/admin")
    // 404, not 403: there is nothing here for a customer to appeal, and a 403
    // advertises the surface.
    expect(response?.status()).toBe(404)
  })
})
