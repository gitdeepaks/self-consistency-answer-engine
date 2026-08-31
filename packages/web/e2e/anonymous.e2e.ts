import { canSeed, expect, expectNoHorizontalOverflow, seedSharedRun, test } from "./fixtures"

/**
 * What somebody with no account can reach.
 *
 * This is the highest-value part of the suite, because it is the only flow that
 * is genuinely end-to-end without an identity provider in the loop: the run is
 * created through the real API, answered by the real worker, published through
 * the real share route, and read by a browser holding no credential at all.
 */

test.describe("the front door", () => {
  test("offers a way in and does not leak the app behind it", async ({ page }) => {
    await page.goto("/")

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible()
    expect(await expectNoHorizontalOverflow(page)).toBe(true)
  })

  test("an authenticated page redirects rather than rendering an empty shell", async ({ page }) => {
    const response = await page.goto("/runs")

    // Either a redirect to sign-in, or the setup screen on an install with no
    // identity provider. What must *not* happen is a history page with no data
    // and no explanation.
    expect(response?.status()).toBeLessThan(500)
    await expect(page).toHaveURL(/\/(sign-in|runs)/)
    await expect(page.getByText(/sign in|identity is not configured/i).first()).toBeVisible()
  })

  test("an unknown page is a not-found, not a crash", async ({ page }) => {
    const response = await page.goto("/no-such-page")
    expect(response?.status()).toBe(404)
    await expect(page.getByRole("heading", { name: /nothing here/i })).toBeVisible()
  })
})

test.describe("share links", () => {
  test("a malformed token is indistinguishable from an unknown one", async ({ page }) => {
    // Both must be 404. Telling an anonymous caller that a link *expired* would
    // confirm it once existed, which turns a guessed token into an oracle.
    for (const token of ["nonsense", `sce_share_${"a".repeat(32)}`]) {
      const response = await page.goto(`/share/${token}`)
      expect(response?.status()).toBe(404)
    }
  })

  test("a published answer is readable with no account", async ({ page }) => {
    test.skip(!canSeed, "needs SCE_API_KEY and a running API to seed a run")

    const prompt = `E2E: why is the sky blue? (${Date.now()})`
    const share = await seedSharedRun(prompt)

    await page.goto(`/share/${share.token}`)

    await expect(page.getByRole("heading", { name: prompt })).toBeVisible()
    await expect(page.getByRole("heading", { name: /^answer$/i })).toBeVisible()
    await expect(page.getByRole("heading", { name: /the panel/i })).toBeVisible()

    // The redaction, checked from the outside: nothing that identifies the
    // workspace, the person or the spend may appear in the served HTML.
    const html = await page.content()
    expect(html).not.toContain(share.runId)
    expect(html).not.toContain("costMicroCents")

    expect(await expectNoHorizontalOverflow(page)).toBe(true)
  })

  test("a shared answer unfurls in a chat client", async ({ page }) => {
    test.skip(!canSeed, "needs SCE_API_KEY and a running API to seed a run")

    const share = await seedSharedRun(`E2E: metadata check (${Date.now()})`)
    await page.goto(`/share/${share.token}`)

    // The growth loop depends on this: a link pasted into Slack has to show the
    // question and the answer, not the site name.
    const description = page.locator('meta[name="description"], meta[property="og:description"]')
    await expect(description.first()).toHaveAttribute("content", /.{20,}/)
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0)
  })
})

test.describe("accessibility floor", () => {
  test("the first tab stop skips to the content", async ({ page }) => {
    // The keyboard-first identity the TUI trains, kept. Without this a keyboard
    // user tabs through the whole header on every navigation.
    await page.goto("/")
    await page.keyboard.press("Tab")

    const focused = page.locator(":focus")
    await expect(focused).toHaveText(/skip to content/i)
    await expect(focused).toBeVisible()
  })

  test("the page declares a language and a single h1", async ({ page }) => {
    await page.goto("/")
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1)
  })

  test("the theme survives a reload without a flash of the wrong palette", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Dark" }).click()
    await expect(page.locator("html")).toHaveClass(/dark/)

    await page.reload()
    // Applied by the inline pre-paint script, so it is already on the element
    // before React hydrates — not set in an effect afterwards.
    await expect(page.locator("html")).toHaveClass(/dark/)
  })
})
