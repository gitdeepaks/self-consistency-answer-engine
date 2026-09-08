import { expect, test } from "bun:test"
import { candidateJobSchema, synthesisJobSchema, webhookJobSchema } from "@sce/shared"

test("durable legacy jobs remain valid and trace carriers are bounded", () => {
  const traceContext = { traceparent: "00-12345678901234567890123456789012-1234567890123456-01", tracestate: "vendor=value" }
  const candidate = { tenantId: "tenant", runId: "run", candidateId: "candidate" }
  expect(candidateJobSchema.parse(candidate).traceContext).toBeUndefined()
  expect(candidateJobSchema.parse({ ...candidate, traceContext }).traceContext).toEqual(traceContext)
  expect(synthesisJobSchema.parse({ tenantId: "tenant", runId: "run", traceContext }).traceContext).toEqual(traceContext)
  expect(webhookJobSchema.parse({ tenantId: "tenant", deliveryId: "delivery" }).traceContext).toBeUndefined()
  expect(candidateJobSchema.safeParse({ ...candidate, traceContext: { traceparent: "invalid" } }).success).toBe(false)
  expect(candidateJobSchema.safeParse({ ...candidate, traceContext: { tracestate: "x".repeat(513) } }).success).toBe(false)
})
