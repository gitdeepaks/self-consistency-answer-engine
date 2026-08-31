import { SignUp } from "@clerk/nextjs"
import type { Metadata } from "next"
import type { ReactElement } from "react"
import { authConfigured } from "@/env"

export const metadata: Metadata = { title: "Create an account" }

export default function SignUpPage(): ReactElement {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-4 py-12">
      {authConfigured() ? (
        <SignUp signInUrl="/sign-in" fallbackRedirectUrl="/ask" />
      ) : (
        <p className="text-sm text-ink-muted">
          Identity is not configured on this install.
        </p>
      )}
    </main>
  )
}
