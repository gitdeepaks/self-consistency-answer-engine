#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App.tsx"
import { serverUrl } from "./api.ts"
import {
  createKey,
  listKeys,
  login,
  logout,
  revokeKey,
  status,
} from "./auth/commands.ts"

const args = process.argv.slice(2)

const HELP = `sce — Self-Consistency Answer Engine

Usage:
  sce                      open the interactive TUI
  sce "<question>"         open the TUI and immediately ask <question>

Authentication:
  sce auth login           sign in through the browser (OAuth 2.0 + PKCE)
    --org <slug>             act inside a particular organization
    --scopes a,b             request narrower scopes than the default
  sce auth logout          forget this machine's credential
  sce auth status          show who the current credential belongs to

API keys (for CI, scripts and the SDK):
  sce keys list
  sce keys create <name>   [--scopes a,b] [--days 90]
  sce keys revoke <id>

Environment:
  SCE_SERVER_URL           backend base URL (currently ${serverUrl})
  SCE_API_KEY              use a key instead of a browser session
  SCE_TENANT               organization slug or id to act inside

Keys:
  enter   ask            esc   browse answers      i     back to the prompt
  ←/→     switch tabs    ↑/↓   scroll              ^h    history
  ^n      new run        ^r    retry last prompt   ^c    quit
`

/**
 * Subcommands, before the renderer starts.
 *
 * Anything to do with credentials prints plain text and exits: these are the
 * commands you run when something is wrong, and taking over the terminal with a
 * full-screen UI at that moment is precisely the wrong thing to do.
 *
 * Returns the exit code, or null when the arguments are not a subcommand and
 * the TUI should open instead.
 */
async function runSubcommand(argv: readonly string[]): Promise<number | null> {
  const [group, action, ...rest] = argv

  if (group === "auth") {
    switch (action) {
      case "login":
        return login(serverUrl, rest)
      case "logout":
        return logout(serverUrl)
      case "status":
      case undefined:
        return status(serverUrl)
      default:
        console.error(`\n  Unknown command: sce auth ${action}\n`)
        return 1
    }
  }

  if (group === "keys") {
    switch (action) {
      case "list":
      case undefined:
        return listKeys(serverUrl)
      case "create":
        return createKey(serverUrl, rest)
      case "revoke":
      case "delete":
        return revokeKey(serverUrl, rest)
      default:
        console.error(`\n  Unknown command: sce keys ${action}\n`)
        return 1
    }
  }

  return null
}

if (args[0] === "--help" || args[0] === "-h") {
  console.log(HELP)
  process.exit(0)
}

const exitCode = await runSubcommand(args)
if (exitCode !== null) process.exit(exitCode)

const initialPrompt = args.filter((arg) => !arg.startsWith("-")).join(" ").trim() || undefined

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 })
createRoot(renderer).render(<App initialPrompt={initialPrompt} />)
