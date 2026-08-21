#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App.tsx"
import { serverUrl } from "./api.ts"

const args = process.argv.slice(2)

if (args[0] === "--help" || args[0] === "-h") {
  console.log(`sce — Self-Consistency Answer Engine

Usage:
  sce                 open the interactive TUI
  sce "<question>"    open the TUI and immediately ask <question>

Environment:
  SCE_SERVER_URL      backend base URL (currently ${serverUrl})

Keys:
  enter   ask            esc   browse answers      i     back to the prompt
  ←/→     switch tabs    ↑/↓   scroll              ^h    history
  ^n      new run        ^r    retry last prompt   ^c    quit
`)
  process.exit(0)
}

const initialPrompt = args.filter((arg) => !arg.startsWith("-")).join(" ").trim() || undefined

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 })
createRoot(renderer).render(<App initialPrompt={initialPrompt} />)
