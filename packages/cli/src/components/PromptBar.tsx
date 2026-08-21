import { theme } from "../theme.ts"

interface PromptBarProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  focused: boolean
  busy: boolean
}

export function PromptBar({ value, onChange, onSubmit, focused, busy }: PromptBarProps) {
  // OpenTUI's `input` intrinsic merges with React's DOM `input`, so `onSubmit`
  // ends up typed as the intersection of two incompatible signatures. Taking
  // `unknown` satisfies both; OpenTUI passes the input's current value.
  const handleSubmit = (value: unknown) => {
    if (typeof value === "string") onSubmit(value)
  }

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      alignItems="center"
      gap={1}
      paddingX={1}
      border
      borderStyle="rounded"
      borderColor={focused ? theme.borderActive : theme.border}
      title={busy ? " ask (running…) " : " ask "}
      titleAlignment="left"
    >
      <text fg={focused ? theme.accent : theme.dim}>❯</text>
      <input
        flexGrow={1}
        value={value}
        onInput={onChange}
        onSubmit={handleSubmit}
        focused={focused}
        placeholder="Ask anything — every model answers, then Claude merges the best answer"
        backgroundColor={theme.panel}
        textColor={theme.text}
        placeholderColor={theme.dim}
        cursorColor={theme.accent}
      />
    </box>
  )
}
