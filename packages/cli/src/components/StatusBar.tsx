import { theme } from "../theme.ts"

function Key({ combo, label }: { combo: string; label: string }) {
  return (
    <text fg={theme.dim}>
      <span fg={theme.accent}>{combo}</span> {label}
    </text>
  )
}

export function StatusBar({ focus, message }: { focus: "prompt" | "output"; message: string | null }) {
  return (
    <box flexDirection="row" flexShrink={0} gap={2} paddingX={1} backgroundColor={theme.panel}>
      {focus === "prompt" ? (
        <>
          <Key combo="enter" label="ask" />
          <Key combo="esc" label="browse answers" />
        </>
      ) : (
        <>
          <Key combo="←/→" label="tabs" />
          <Key combo="↑/↓" label="scroll" />
          <Key combo="i" label="ask again" />
        </>
      )}
      <Key combo="^h" label="history" />
      <Key combo="^n" label="new" />
      <Key combo="^r" label="retry" />
      <Key combo="^c" label="quit" />
      {message && (
        <text fg={theme.err} flexGrow={1}>
          {message}
        </text>
      )}
    </box>
  )
}
