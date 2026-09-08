import { expect, spyOn, test } from "bun:test"
import { metrics } from "@sce/observability"
import { Hono } from "hono"
import { httpTelemetry } from "./telemetry.ts"
import type { AuthEnv } from "./auth/middleware.ts"

test("HTTP metrics label route templates, including early v1 refusals and 404s", async () => {
  const count = spyOn(metrics, "count")
  const histogram = spyOn(metrics, "histogram")
  try {
    const app = new Hono<AuthEnv>()
      .use("*", httpTelemetry)
      .use("/v1/runs", async (c) => c.json({ error: "denied" }, 401))
      .post("/v1/runs", (c) => c.json({ ok: true }))
      .get("/v1/runs/:id", (c) => c.json({ ok: true }))
    await app.request("/v1/runs/private-id?prompt=secret")
    expect(count).toHaveBeenCalledWith("sce.http.requests", 1, { method: "GET", route: "/v1/runs/:id", status_class: "2xx" })
    await app.request("/v1/runs", { method: "POST" })
    expect(count).toHaveBeenCalledWith("sce.http.requests", 1, { method: "POST", route: "/v1/runs", status_class: "4xx" })
    await app.request("/random-private-path")
    expect(count).toHaveBeenCalledWith("sce.http.requests", 1, { method: "GET", route: "unmatched", status_class: "4xx" })
    expect(JSON.stringify(histogram.mock.calls)).not.toContain("secret")
    expect(JSON.stringify(count.mock.calls)).not.toContain("private")
  } finally {
    count.mockRestore()
    histogram.mockRestore()
  }
})
