import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Rewrite `.ts` specifiers to `.js` in the emitted declarations.
 *
 * The repository imports with explicit `.ts` extensions — `allowImportingTsExtensions`,
 * which Bun runs natively and which keeps a module's imports resolvable without
 * a build step. TypeScript's `rewriteRelativeImportExtensions` fixes those up
 * when it emits *JavaScript*, but this package emits declarations only, and
 * declaration output carries module specifiers through verbatim.
 *
 * Left alone, a consumer's compiler would follow `./client.ts` out of a `.d.ts`
 * file, find no such file in the published package, and report every export as
 * missing — the failure that makes a package look broken while its runtime
 * works perfectly. Rewriting to `./client.js` resolves to `client.d.ts`, which
 * is what ships.
 *
 * Only *relative* specifiers are touched. A bare `zod` import has no extension
 * and must keep resolving through node_modules.
 */

const RELATIVE_TS = /(from\s+|import\s*\(\s*)(["'])(\.\.?\/[^"']*)\.ts\2/g

async function* declarations(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* declarations(full)
    else if (entry.name.endsWith(".d.ts")) yield full
  }
}

const root = path.join(import.meta.dir, "..", "dist", "types")

let rewritten = 0
for await (const file of declarations(root)) {
  const source = await readFile(file, "utf8")
  const next = source.replace(RELATIVE_TS, (_match, keyword: string, quote: string, target: string) =>
    `${keyword}${quote}${target}.js${quote}`,
  )
  if (next !== source) {
    await writeFile(file, next)
    rewritten += 1
  }
}

console.log(`[sdk] rewrote import extensions in ${rewritten} declaration files`)
