import { z } from "zod"

/**
 * Web configuration, parsed once at module load.
 *
 * The same parse-at-the-boundary rule the API and the worker follow, with one
 * constraint that is specific to Next and easy to get wrong:
 *
 * **`process.env` cannot be read as an object in browser code.** Next inlines
 * `NEXT_PUBLIC_*` variables at build time by *textual substitution* of the
 * literal expression `process.env.NEXT_PUBLIC_FOO`. Handing `process.env` to a
 * schema — the shape `packages/server/src/env.ts` uses — would compile to an
 * empty object in the browser bundle and fail at runtime in production while
 * working perfectly in development, which is the worst failure mode available.
 *
 * So each variable is named literally below, and the resulting record is what
 * gets parsed. The validation is identical; only the way the values are reached
 * differs, and it differs for a reason worth writing down rather than
 * rediscovering.
 */

/** An absolute origin with no trailing slash, so callers can concatenate. */
const originSchema = z
  .url("must be an absolute URL, e.g. https://api.example.com")
  .transform((value) => value.replace(/\/$/, ""))

const publicEnvSchema = z.object({
  /**
   * Where the Hono API lives.
   *
   * The browser talks to it directly rather than through a Next route handler
   * proxy. That is a deliberate choice: the run stream is a long-lived SSE
   * connection, and putting a serverless function in the middle of one buys
   * nothing and adds a hop that platforms are prone to time out. The API's CORS
   * allowlist and Clerk bearer tokens are what make it safe.
   */
  NEXT_PUBLIC_API_URL: originSchema.default("http://localhost:8787"),

  /**
   * This app's own origin.
   *
   * Needed because share links are built server-side, and a link is worthless
   * if it points at `localhost` in an email. Not derived from the request host:
   * that is attacker-controlled, and a `Host` header is exactly how a share
   * link gets rewritten to point somewhere else.
   */
  NEXT_PUBLIC_APP_URL: originSchema.default("http://localhost:3000"),

  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .trim()
    .regex(
      /^pk_(test|live)_[A-Za-z0-9+/=]+$/,
      "must look like pk_test_… or pk_live_… — the key from Clerk's dashboard",
    )
    .optional(),
})

type PublicEnv = z.infer<typeof publicEnvSchema>

function parse(): PublicEnv {
  const parsed = publicEnvSchema.safeParse({
    // Literal accesses. See the note above — these are substituted at build
    // time and cannot be reached through a dynamic key.
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  })

  if (!parsed.success) {
    const report = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    throw new Error(`Invalid web configuration:\n${report}`)
  }

  return parsed.data
}

const env = parse()

/**
 * The typed configuration the rest of the app reads.
 *
 * Named fields rather than raw variable names, so renaming an environment
 * variable is a change to this file alone.
 */
export const config = {
  apiUrl: env.NEXT_PUBLIC_API_URL,
  appUrl: env.NEXT_PUBLIC_APP_URL,
  clerkPublishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
} as const

/**
 * Is identity wired up?
 *
 * An install with no Clerk keys still boots and still renders — it simply
 * cannot sign anybody in, and every page that needs a session says so in
 * words instead of throwing a stack trace at a first-time developer. This
 * mirrors `clerkConfigured()` on the API side, which makes the same allowance
 * so that API-key traffic keeps working without an identity provider.
 */
export function authConfigured(): boolean {
  return config.clerkPublishableKey !== null
}
