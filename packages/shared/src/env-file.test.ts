import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadRootEnv } from "./env-file.ts"

const dirs: string[] = []
const touched: string[] = []

afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key]
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(contents: string): { root: string; nested: string } {
  const root = mkdtempSync(path.join(tmpdir(), "sce-env-"))
  dirs.push(root)
  writeFileSync(path.join(root, ".env"), contents)
  const nested = path.join(root, "packages", "server")
  mkdirSync(nested, { recursive: true })
  return { root, nested }
}

test("finds the .env above the starting directory", () => {
  const { root, nested } = fixture("SCE_TEST_ONE=hello\n")
  touched.push("SCE_TEST_ONE")

  expect(loadRootEnv(nested)).toBe(path.join(root, ".env"))
  expect(process.env.SCE_TEST_ONE).toBe("hello")
})

test("parses quotes, exports, comments and blank lines", () => {
  const { nested } = fixture(
    [
      "# a comment",
      "",
      'SCE_TEST_QUOTED="quoted value"',
      "SCE_TEST_SINGLE='single value'",
      "export SCE_TEST_EXPORTED=exported",
      "SCE_TEST_TRAILING=value # trailing comment",
      "SCE_TEST_EMPTY=",
      "not a valid line",
    ].join("\n"),
  )
  touched.push(
    "SCE_TEST_QUOTED",
    "SCE_TEST_SINGLE",
    "SCE_TEST_EXPORTED",
    "SCE_TEST_TRAILING",
    "SCE_TEST_EMPTY",
  )

  loadRootEnv(nested)

  expect(process.env.SCE_TEST_QUOTED).toBe("quoted value")
  expect(process.env.SCE_TEST_SINGLE).toBe("single value")
  expect(process.env.SCE_TEST_EXPORTED).toBe("exported")
  expect(process.env.SCE_TEST_TRAILING).toBe("value")
  expect(process.env.SCE_TEST_EMPTY).toBe("")
})

test("never overwrites a value that is already set", () => {
  const { nested } = fixture("SCE_TEST_WINS=from-file\n")
  touched.push("SCE_TEST_WINS")
  process.env.SCE_TEST_WINS = "from-environment"

  loadRootEnv(nested)

  expect(process.env.SCE_TEST_WINS).toBe("from-environment")
})

test("returns null when there is no .env to find", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "sce-noenv-"))
  dirs.push(empty)
  const deep = path.join(empty, "a", "b")
  mkdirSync(deep, { recursive: true })

  expect(loadRootEnv(deep)).toBeNull()
})
