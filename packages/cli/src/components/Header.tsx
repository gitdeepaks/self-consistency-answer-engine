import type { ProviderHealth } from "@sce/shared"
import { theme } from "../theme.ts"

interface HeaderProps {
  panel: ProviderHealth[]
  evaluator: ProviderHealth | null
  serverUrl: string
  connected: boolean
  /** Terminal is short — drop the ASCII banner. */
  compact: boolean
  /** Terminal width, used to shed the optional right-hand items. */
  width: number
}

function Badge({ provider }: { provider: ProviderHealth }) {
  const color = provider.available ? provider.color : theme.dim
  return (
    <text fg={color} flexShrink={0}>
      {provider.available ? "●" : "○"} {provider.label}
    </text>
  )
}

export function Header({
  panel,
  evaluator,
  serverUrl,
  connected,
  compact,
  width,
}: HeaderProps) {
  // The header is one non-wrapping row, so shed the optional items rather than
  // letting them collide on a narrow terminal.
  const showUrl = width >= 108 || !connected
  const showEvaluator = width >= 92
  const title = width >= 76 ? "Self-Consistency Answer Engine" : "SCE"

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
      backgroundColor={theme.panel}
      borderStyle="rounded"
      border={["bottom"]}
      borderColor={theme.border}
    >
      {!compact && <ascii-font text="SCE" font="tiny" color={theme.accent} />}
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={theme.accent} flexShrink={0}>
          <strong>{title}</strong>
        </text>
        <box flexDirection="row" gap={2} flexGrow={1}>
          {panel.map((provider) => (
            <Badge key={provider.id} provider={provider} />
          ))}
          {showEvaluator && evaluator && (
            <text fg={evaluator.available ? theme.magenta : theme.dim}>⚖ {evaluator.model}</text>
          )}
        </box>
        {showUrl && (
          <text fg={connected ? theme.dim : theme.err} flexShrink={0}>
            {connected ? serverUrl : `offline · ${serverUrl}`}
          </text>
        )}
      </box>
    </box>
  )
}
