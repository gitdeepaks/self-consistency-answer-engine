import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import type { ProviderHealth, RunSummary } from "@sce/shared"
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import {
  createRun,
  fetchHistory,
  fetchProviders,
  fetchRun,
  serverUrl,
  streamRun,
  type ProviderStatus,
} from "./api.ts"
import { ContentView, TabBar, buildTabs } from "./components/ContentView.tsx"
import { Header } from "./components/Header.tsx"
import { HistoryView } from "./components/HistoryView.tsx"
import { PanelStatus } from "./components/PanelStatus.tsx"
import { PromptBar } from "./components/PromptBar.tsx"
import { StatusBar } from "./components/StatusBar.tsx"
import { engineReducer, initialState } from "./state.ts"
import { theme } from "./theme.ts"

type Focus = "prompt" | "output"

export function App({ initialPrompt }: { initialPrompt?: string }) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()

  const [state, dispatch] = useReducer(engineReducer, initialState)
  const [providers, setProviders] = useState<ProviderStatus | null>(null)
  const [connected, setConnected] = useState(true)
  const [prompt, setPrompt] = useState("")
  const [lastPrompt, setLastPrompt] = useState(initialPrompt ?? "")
  const [focus, setFocus] = useState<Focus>("prompt")
  const [tabIndex, setTabIndex] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<RunSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // One in-flight subscription at a time; starting a new run cancels the old.
  const streamAbort = useRef<AbortController | null>(null)

  const busy = state.phase === "starting" || state.phase === "running"

  const colorOf = useCallback(
    (providerId: string) =>
      providers?.panel.find((p) => p.id === providerId)?.color ?? theme.text,
    [providers],
  )
  const tabs = useMemo(() => buildTabs(state.run, colorOf), [state.run, colorOf])
  const activeTab = tabs[Math.min(tabIndex, tabs.length - 1)]

  // Poll for the API rather than giving up after one try: `bun run dev` boots
  // the server and the TUI at the same instant, and the server also restarts on
  // every save while --watch is running.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const attempt = async (tries: number) => {
      if (cancelled) return
      try {
        const result = await fetchProviders()
        if (cancelled) return
        setProviders(result)
        setConnected(true)
        const offline = result.panel.filter((p: ProviderHealth) => !p.available)
        setNotice(
          offline.length === result.panel.length
            ? "No provider credentials configured — see .env.example"
            : null,
        )
      } catch {
        if (cancelled) return
        setConnected(false)
        setNotice(`Waiting for the API at ${serverUrl}…`)
        timer = setTimeout(() => void attempt(tries + 1), Math.min(400 * 2 ** tries, 4000))
      }
    }

    void attempt(0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const follow = useCallback(async (runId: string) => {
    streamAbort.current?.abort()
    const controller = new AbortController()
    streamAbort.current = controller

    try {
      for await (const event of streamRun(runId, controller.signal)) {
        dispatch({ type: "event", event })
      }
    } catch (error) {
      if (controller.signal.aborted) return
      // The stream died mid-run; fall back to a one-shot read so the user still
      // sees whatever the server managed to persist.
      try {
        dispatch({ type: "loaded", run: await fetchRun(runId) })
      } catch {
        dispatch({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }, [])

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim()
      if (trimmed.length < 3) {
        setNotice("Ask something a little longer than that.")
        return
      }

      setNotice(null)
      setLastPrompt(trimmed)
      setPrompt("")
      setTabIndex(0)
      setFocus("output")
      setHistoryOpen(false)
      dispatch({ type: "starting", prompt: trimmed })

      try {
        const run = await createRun({ prompt: trimmed })
        setConnected(true)
        dispatch({ type: "loaded", run })
        void follow(run.id)
      } catch (error) {
        setConnected(false)
        dispatch({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [follow],
  )

  const openHistory = useCallback(async () => {
    setHistoryOpen(true)
    setHistoryLoading(true)
    try {
      setHistory(await fetchHistory())
      setConnected(true)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const openRun = useCallback(
    async (id: string) => {
      setHistoryOpen(false)
      setTabIndex(0)
      setFocus("output")
      try {
        const run = await fetchRun(id)
        dispatch({ type: "loaded", run })
        setLastPrompt(run.prompt)
        // Still in flight? Attach to its live stream.
        if (run.status !== "COMPLETE" && run.status !== "FAILED") void follow(run.id)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    [follow],
  )

  // Fire the run passed on the command line, once providers are known.
  const autoRan = useRef(false)
  useEffect(() => {
    if (autoRan.current || !initialPrompt || !providers) return
    autoRan.current = true
    void ask(initialPrompt)
  }, [initialPrompt, providers, ask])

  useEffect(() => () => streamAbort.current?.abort(), [])

  useKeyboard((key) => {
    if (key.ctrl && key.name === "h") {
      if (historyOpen) setHistoryOpen(false)
      else void openHistory()
      return
    }
    if (key.ctrl && key.name === "n") {
      streamAbort.current?.abort()
      dispatch({ type: "reset" })
      setPrompt("")
      setHistoryOpen(false)
      setFocus("prompt")
      setNotice(null)
      return
    }
    if (key.ctrl && key.name === "r") {
      if (lastPrompt && !busy) void ask(lastPrompt)
      return
    }

    if (historyOpen) {
      if (key.name === "escape") setHistoryOpen(false)
      return
    }

    if (key.name === "escape") {
      setFocus("output")
      return
    }

    // Everything below is browse-mode only; while the prompt has focus those
    // keystrokes belong to the text input.
    if (focus !== "output") return

    if (key.name === "i" || key.name === "/") {
      setFocus("prompt")
      return
    }
    if (key.name === "left" || key.name === "h") {
      setTabIndex((index) => (index - 1 + tabs.length) % tabs.length)
      return
    }
    if (key.name === "right" || key.name === "l" || key.name === "tab") {
      setTabIndex((index) => (index + 1) % tabs.length)
      return
    }
    if (key.name === "q") {
      renderer.destroy()
    }
  })

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
      <Header
        panel={providers?.panel ?? []}
        evaluator={providers?.evaluator ?? null}
        serverUrl={serverUrl}
        connected={connected}
        compact={height < 32}
        width={width}
      />
      <PromptBar
        value={prompt}
        onChange={setPrompt}
        onSubmit={ask}
        focused={focus === "prompt" && !historyOpen}
        busy={busy}
      />
      <PanelStatus
        run={state.run}
        panel={providers?.panel ?? []}
        stage={state.error ?? state.stage}
        busy={busy}
      />
      {historyOpen ? (
        <HistoryView items={history} loading={historyLoading} onSelect={openRun} focused />
      ) : (
        <>
          <TabBar tabs={tabs} activeIndex={tabs.indexOf(activeTab!)} />
          <ContentView run={state.run} tab={activeTab} focused={focus === "output"} />
        </>
      )}
      <StatusBar focus={focus} message={notice} />
    </box>
  )
}
