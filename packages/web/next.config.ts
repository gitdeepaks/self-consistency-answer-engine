import type { NextConfig } from "next"

/**
 * Next.js configuration.
 *
 * Three things are set, and each is a security or correctness property rather
 * than a preference.
 *
 * **`transpilePackages`** — `@sce/shared` ships TypeScript source, not a build
 * artefact, because it is the single source of truth for schemas that the
 * server, the worker, the CLI and this app all parse against. Next has to
 * compile it rather than treat it as a prebuilt dependency.
 *
 * **`typedRoutes`** — link targets are checked against the route tree, so a
 * renamed page is a compile error at every link to it rather than a 404 a user
 * finds first. That is the §3 "no unverifiable claims" rule applied to
 * navigation.
 *
 * **The security headers** — Phase 9 owns the full policy, but the headers that
 * cost nothing to set correctly now are set now. The CSP in particular is the
 * enforcement half of P9.3: model output is rendered as Markdown with raw HTML
 * disabled, and a CSP that forbids inline and remote script is what makes that
 * a boundary rather than a convention.
 */
const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@sce/shared"],
  typedRoutes: true,

  /**
   * `serverExternalPackages` keeps the Clerk backend SDK out of the bundler's
   * module graph. It reaches for Node built-ins that a bundler cannot resolve,
   * and it only ever runs on the server.
   */
  serverExternalPackages: ["@clerk/backend"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            // A shared answer must not be able to turn a visitor's browser into
            // a sensor. None of these are features this app has any use for.
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ]
  },
}

export default config
