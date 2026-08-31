import { ClerkProvider } from "@clerk/nextjs"
import type { Metadata, Viewport } from "next"
import type { ReactElement, ReactNode } from "react"
import { THEME_SCRIPT } from "@/components/theme-toggle"
import { authConfigured, config } from "@/env"
import "./globals.css"

/**
 * The root layout.
 *
 * Two things happen here that cannot happen anywhere else.
 *
 * **The theme is applied before first paint.** The inline script in `<head>`
 * reads the stored preference and sets the class synchronously. Doing it in an
 * effect instead is what produces the white flash on every dark-mode app that
 * has not fixed it yet.
 *
 * **Clerk is optional.** A clone of this repo with no keys still renders every
 * page that needs no session — the marketing page, a share link, the health
 * check — instead of failing at the provider. `ClerkProvider` throws without a
 * publishable key, so it is mounted only when there is one, and the pages that
 * need identity say so in words.
 */

export const metadata: Metadata = {
  title: {
    default: "Self-Consistency Answer Engine",
    template: "%s · SCE",
  },
  description:
    "Ask several frontier models the same question, then read one answer synthesised from where they agree — and see exactly where they did not.",
  metadataBase: new URL(config.appUrl),
  // Shared answers are the growth loop, so they need to unfurl properly in a
  // chat client. Per-page metadata overrides this; the defaults are the floor.
  openGraph: {
    type: "website",
    siteName: "Self-Consistency Answer Engine",
  },
  robots: {
    // The application is private by construction; only `/share/*` opts back in,
    // which it does with its own per-page metadata.
    index: false,
    follow: false,
  },
}

export const viewport: Viewport = {
  // The browser paints its own chrome from this, so it has to move with the
  // theme rather than being a single colour that is wrong half the time.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfc" },
    { media: "(prefers-color-scheme: dark)", color: "#16181d" },
  ],
}

function Document({ children }: { children: ReactNode }): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line react/no-danger — see THEME_SCRIPT: this is
            a constant string built at module scope from a literal, never from
            user input, and it has to run synchronously before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        {/*
          The first thing a keyboard user reaches on every page. Visually hidden
          until focused, which is why it is not simply `sr-only`.
        */}
        <a
          href="#main"
          className="sr-only rounded-md bg-accent px-4 py-2 text-accent-contrast focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  )
}

export default function RootLayout({ children }: { children: ReactNode }): ReactElement {
  if (!authConfigured()) return <Document>{children}</Document>

  return (
    <ClerkProvider
      // Passed explicitly rather than read from the ambient environment, so the
      // key this app uses is the one `env.ts` validated at boot.
      publishableKey={config.clerkPublishableKey ?? undefined}
      appearance={{ variables: { colorPrimary: "#5b6ee1" } }}
    >
      <Document>{children}</Document>
    </ClerkProvider>
  )
}
