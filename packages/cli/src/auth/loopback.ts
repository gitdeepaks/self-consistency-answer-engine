import { spawn } from "node:child_process"
import { statesMatch } from "./pkce.ts"

/**
 * The one-shot loopback listener that catches the authorization code.
 *
 * RFC 8252 §7.3 is specific about the shape of this, and each detail matters:
 *
 *   - bind `127.0.0.1`, not `localhost` — the name can resolve to `::1` or, on
 *     a misconfigured machine, to something else entirely;
 *   - take an **ephemeral** port, because a fixed one collides with whatever
 *     else the developer is running and cannot be held across two logins;
 *   - serve exactly one callback and shut down, so nothing is left listening
 *     after the flow completes.
 */

export interface CallbackResult {
  code: string
  state: string
}

export interface Loopback {
  /** `http://127.0.0.1:<port>/callback` — register this with the OAuth app. */
  redirectUri: string
  /** Resolves once the browser hits the callback; rejects on error or timeout. */
  waitForCode: () => Promise<CallbackResult>
  close: () => void
}

/** What the browser tab shows once the code has been handed over. */
function page(title: string, message: string, accent: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
         background:#0b0d10; color:#e8eaed; }
  main { text-align:center; padding:2rem; max-width:32rem; }
  h1 { font-size:1.25rem; margin:0 0 .5rem; color:${accent}; }
  p { margin:0; color:#9aa4b2; }
</style></head>
<body><main><h1>${title}</h1><p>${message}</p></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  )
}

/** How long to wait for someone to finish signing in before giving up. */
const LOGIN_TIMEOUT_MS = 5 * 60_000

/**
 * Start listening for the callback.
 *
 * `expectedState` is compared here rather than by the caller so that a crafted
 * request to the loopback port — which any local process can make — cannot
 * inject an authorization code the CLI would then redeem.
 */
export function startLoopback(expectedState: string): Loopback {
  let settle: ((result: CallbackResult) => void) | null = null
  let fail: ((error: Error) => void) | null = null

  const received = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  // The browser can hit the callback before the caller reaches its `await` —
  // a fast redirect, or an `?error=` that comes back immediately. Without a
  // handler attached now, that rejection is "unhandled" for a tick and the
  // runtime prints a stack trace over the login prompt. Marking it handled
  // here changes nothing for the real consumer: `waitForCode()` hands out the
  // same promise, and it still rejects.
  received.catch(() => {})

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 })

      // The authorization server reports a refusal here rather than at the
      // token endpoint, so a declined consent screen has to be read from the
      // query string — otherwise the CLI just hangs until the timeout.
      const error = url.searchParams.get("error")
      if (error !== null) {
        const description = url.searchParams.get("error_description") ?? error
        fail?.(new Error(`Authorization was refused: ${description}`))
        return page("Sign-in failed", description, "#f87171")
      }

      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")

      if (code === null || state === null) {
        fail?.(new Error("The authorization server did not return a code"))
        return page("Sign-in failed", "No authorization code was returned.", "#f87171")
      }

      if (!statesMatch(expectedState, state)) {
        // Someone else's callback, or a forgery. Never redeem the code.
        fail?.(new Error("Authorization state did not match — the sign-in was not completed"))
        return page("Sign-in failed", "The request could not be verified.", "#f87171")
      }

      settle?.({ code, state })
      return page("You're signed in", "You can close this tab and return to your terminal.", "#4ade80")
    },
  })

  const timer = setTimeout(() => {
    fail?.(new Error("Timed out waiting for the browser to complete sign-in"))
  }, LOGIN_TIMEOUT_MS)
  // Do not hold the process open on the timer alone.
  timer.unref?.()

  const close = (): void => {
    clearTimeout(timer)
    void server.stop(true)
  }

  return {
    redirectUri: `http://127.0.0.1:${server.port}/callback`,
    waitForCode: () => received,
    close,
  }
}

/**
 * Open a URL in the user's browser, best effort.
 *
 * Failure is not fatal: the URL is always printed as well, so a headless or
 * remote session is a copy-paste away rather than a dead end.
 */
export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"

  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Printed by the caller regardless.
  }
}
