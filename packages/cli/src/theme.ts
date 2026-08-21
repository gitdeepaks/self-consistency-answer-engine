import { SyntaxStyle } from "@opentui/core"

export const theme = {
  bg: "#0b0d12",
  panel: "#131722",
  panelAlt: "#171c29",
  border: "#252c3d",
  borderActive: "#3d5a99",
  text: "#c9d3e0",
  dim: "#6b7688",
  accent: "#7aa2f7",
  ok: "#4ade80",
  warn: "#fbbf24",
  err: "#f87171",
  magenta: "#c084fc",
} as const

/** Colour table the <markdown> renderable looks up while drawing. */
export const markdownStyle: SyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: theme.text },
  text: { fg: theme.text },
  string: { fg: theme.ok },
  conceal: { fg: theme.dim, dim: true },
  "markup.heading": { fg: theme.accent, bold: true },
  "markup.strong": { fg: "#ffffff", bold: true },
  "markup.italic": { fg: theme.text, italic: true },
  "markup.strikethrough": { fg: theme.dim, dim: true },
  "markup.list": { fg: theme.magenta },
  "markup.quote": { fg: theme.dim, italic: true },
  "markup.raw": { fg: theme.warn },
  "markup.link": { fg: theme.accent, underline: true },
  "markup.link.label": { fg: theme.accent },
  "markup.link.url": { fg: theme.dim, underline: true },
})
