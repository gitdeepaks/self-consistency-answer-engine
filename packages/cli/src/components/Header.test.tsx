import { afterEach, expect, test } from "bun:test"
import type { ProviderHealth } from "@sce/shared"
import { testRender } from "@opentui/react/test-utils"
import { Header } from "./Header.tsx"

/**
 * The header is a single non-wrapping row. These pin which items survive as the
 * terminal narrows, so nothing ever collides into unreadable overlap.
 */

const panel: ProviderHealth[] = [
  { id: "openai", label: "OpenAI", model: "gpt-5.5", color: "#10a37f", available: true, route: "direct", hint: null },
  { id: "anthropic", label: "Claude", model: "claude-sonnet-5", color: "#d97757", available: true, route: "direct", hint: null },
  { id: "google", label: "Gemini", model: "gemini-3.7-flash", color: "#4285f4", available: false, route: null, hint: "Set GOOGLE_GENERATIVE_AI_API_KEY" },
]

const evaluator: ProviderHealth = {
  id: "anthropic",
  label: "Claude",
  model: "claude-opus-5",
  color: "#d97757",
  available: true,
  route: "direct",
  hint: null,
}

let setup: Awaited<ReturnType<typeof testRender>> | null = null

afterEach(() => {
  setup?.renderer.destroy()
  setup = null
})

async function render(width: number, connected = true) {
  setup = await testRender(
    <Header
      panel={panel}
      evaluator={evaluator}
      serverUrl="http://localhost:8787"
      connected={connected}
      compact
      width={width}
    />,
    { width, height: 6 },
  )
  await setup.renderOnce()
  return setup.captureCharFrame()
}

test("a wide terminal shows every item", async () => {
  const frame = await render(120)
  expect(frame).toContain("Self-Consistency Answer Engine")
  expect(frame).toContain("● OpenAI")
  expect(frame).toContain("● Claude")
  // An unconfigured provider gets a hollow marker.
  expect(frame).toContain("○ Gemini")
  expect(frame).toContain("claude-opus-5")
  expect(frame).toContain("http://localhost:8787")
})

test("at 80 columns the badges survive and the URL is dropped", async () => {
  const frame = await render(80)
  expect(frame).toContain("Self-Consistency Answer Engine")
  expect(frame).toContain("● OpenAI")
  expect(frame).toContain("● Claude")
  expect(frame).toContain("○ Gemini")
  expect(frame).not.toContain("http://localhost:8787")
  // Every rendered line must fit the terminal.
  for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(80)
})

test("a very narrow terminal keeps the badges and shortens the title", async () => {
  const frame = await render(60)
  expect(frame).toContain("SCE")
  expect(frame).not.toContain("Self-Consistency Answer Engine")
  expect(frame).toContain("● OpenAI")
})

test("a disconnected server is always reported, however narrow", async () => {
  const frame = await render(80, false)
  expect(frame).toContain("offline")
})
