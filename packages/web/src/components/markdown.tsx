"use client"

import type { ReactElement } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/cn"

/**
 * Rendering model output.
 *
 * This component is a security boundary, not a styling convenience. Everything
 * it renders was written by a language model, and a language model's output is
 * **untrusted data** — it may have been steered by a prompt injection carried
 * in the user's own question. Phase 9 owns the full threat model; the three
 * defences that belong at the render site are here, because retrofitting them
 * later means auditing every place an answer is displayed.
 *
 * **1. Raw HTML never renders.** `react-markdown` ignores embedded HTML unless
 * `rehype-raw` is added, and it is deliberately not added. So `<script>`,
 * `<iframe>`, `<img onerror=…>` and `<form action=…>` in a model's answer are
 * text on the page, which is what they are. This is the enforcement half of the
 * "treat model output as data, never as instructions" rule.
 *
 * **2. URLs are protocol-restricted.** `urlTransform` drops anything that is
 * not `http`, `https` or `mailto`, so `javascript:` and `data:` links cannot be
 * produced. Links open in a new tab with `rel="noopener noreferrer nofollow"`:
 * `noopener` stops the target reaching back through `window.opener`, and
 * `nofollow` stops this product's shared pages becoming an SEO donation to
 * whatever a model was talked into linking to.
 *
 * **3. Remote images are not loaded.** An `<img src="https://attacker/…">` in
 * an answer is a request the *reader's* browser makes to a third party — a
 * tracking pixel at best, and at worst a channel that carries data out in its
 * query string. So an image becomes a labelled link the reader can choose to
 * follow, rather than a fetch nobody consented to. This is the "strip or proxy
 * remote images" rule from P9.3, and stripping is what is affordable now.
 */

const components: Components = {
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...props}>
      {children}
    </a>
  ),

  img: ({ src, alt }) => {
    // `src` is typed as possibly absent by the AST; an image with no source is
    // nothing at all.
    if (typeof src !== "string" || src.length === 0) return null
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex items-center gap-1 text-sm"
        // The reader should know this is not being loaded, and why, before they
        // decide whether to open it.
        title="Images in model output are not loaded automatically. Open in a new tab to view."
      >
        {alt !== undefined && alt.length > 0 ? `Image: ${alt}` : "Image"} ↗
      </a>
    )
  },
}

/** Protocols an answer may link to. Everything else is dropped. */
const SAFE_PROTOCOL = /^(https?:|mailto:)/i

function safeUrl(url: string): string {
  // A relative URL has no protocol and is harmless; an absolute one has to be
  // on the list. Returning "" makes `react-markdown` render the text without a
  // link, which is the correct degradation.
  if (!url.includes(":")) return url
  return SAFE_PROTOCOL.test(url) ? url : ""
}

export function Markdown({
  children,
  className,
}: {
  children: string
  className?: string
}): ReactElement {
  return (
    <div className={cn("prose-answer text-sm text-ink", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Highlighting is applied to the *parsed* code node's text, after the
        // Markdown AST has been built — so it colours a fenced block and can
        // never introduce an element the Markdown did not already contain.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        urlTransform={safeUrl}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
