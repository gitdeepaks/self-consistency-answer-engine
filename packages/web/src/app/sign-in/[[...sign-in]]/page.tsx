import { SignIn } from "@clerk/nextjs"
import type { Metadata } from "next"
import type { ReactElement } from "react"
import { authConfigured } from "@/env"

export const metadata: Metadata = { title: "Sign in" }

export default function SignInPage(): ReactElement {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      {authConfigured() ? (
        <SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/ask" />
      ) : (
        <p className="text-sm text-ink-muted">
          Identity is not configured on this install.
        </p>
      )}
    </main>
  )
}
