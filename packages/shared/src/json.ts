import { z } from "zod";

/**
 * A JSON value, and the parser that produces one.
 *
 * Native `Json` database columns and typed application objects sit on opposite
 * sides of a trust boundary: the driver hands back `unknown`, and the driver's
 * input type is a structural JSON type that a domain object is not
 * automatically assignable to. Rather than asserting across that gap in either
 * direction, everything passes through this parser — which is also the only
 * thing that actually proves a value survives a round trip through JSON.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * A JSON value that can be *written* to a `Json` column.
 *
 * Excludes a bare top-level `null`, which database drivers treat as ambiguous
 * (SQL NULL or JSON null?) and therefore refuse. Nested nulls are fine.
 */
export const jsonWritableSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]);
export type JsonWritable = z.infer<typeof jsonWritableSchema>;

/** Validate that a domain value is representable as JSON, and type it as such. */
export function toJson(value: unknown): JsonWritable {
  return jsonWritableSchema.parse(value);
}
