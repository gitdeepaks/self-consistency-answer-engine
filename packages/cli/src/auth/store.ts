import {
  clearCredential,
  credentialKey,
  credentialsPath,
  readCredential,
  storedCredentialSchema,
  writeCredential,
  type StoredCredential,
} from "@sce/shared"

/**
 * Where the CLI keeps its credential.
 *
 * Preference order is OS keychain first, `~/.config/sce/credentials.json`
 * (mode 0600) second. The keychain is better because it survives a stray
 * `cat ~/.config/**` and is encrypted at rest with the login session; the file
 * exists because CI runners, containers and headless boxes have no keychain and
 * a CLI that refuses to work without one is a CLI nobody can automate.
 *
 * Both stores hold the same JSON document, so moving between them — a laptop
 * that gains a keychain, a container that loses one — needs no migration.
 */

const SERVICE = "sce-cli"

export type StorageBackend = "keychain" | "file"

/** Which backend a credential came from, for `sce auth status` to report. */
export interface LoadedCredential {
  credential: StoredCredential
  backend: StorageBackend
}

interface Keychain {
  get: (account: string) => string | null
  set: (account: string, secret: string) => boolean
  delete: (account: string) => void
}

function run(command: string, args: string[], stdin?: string): { ok: boolean; stdout: string } {
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "ignore",
    })
    return { ok: result.exitCode === 0, stdout: new TextDecoder().decode(result.stdout) }
  } catch {
    // The tool is not installed. Not an error — it is the signal to fall back.
    return { ok: false, stdout: "" }
  }
}

/**
 * macOS Keychain, via the `security` tool.
 *
 * Caveat worth stating rather than hiding: `add-generic-password` takes the
 * secret as an argument, so it is briefly visible in `ps` output to other
 * processes of the same user on the same machine. There is no stdin form of
 * that flag. It is still a clear improvement over a plaintext file, and the
 * exposure window is one `execve` — but it is not zero.
 */
const macKeychain: Keychain = {
  get(account) {
    const { ok, stdout } = run("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      SERVICE,
      "-w",
    ])
    const secret = stdout.trim()
    return ok && secret !== "" ? secret : null
  },
  set(account, secret) {
    // `-U` updates in place when the item already exists, which is what makes
    // a second login replace the first rather than duplicating it.
    return run("security", [
      "add-generic-password",
      "-a",
      account,
      "-s",
      SERVICE,
      "-U",
      "-w",
      secret,
    ]).ok
  },
  delete(account) {
    run("security", ["delete-generic-password", "-a", account, "-s", SERVICE])
  },
}

/** Freedesktop Secret Service, via `secret-tool`. Reads the secret from stdin. */
const secretTool: Keychain = {
  get(account) {
    const { ok, stdout } = run("secret-tool", ["lookup", "service", SERVICE, "account", account])
    return ok && stdout.trim() !== "" ? stdout.trim() : null
  },
  set(account, secret) {
    return run(
      "secret-tool",
      ["store", "--label=Self-Consistency Answer Engine", "service", SERVICE, "account", account],
      secret,
    ).ok
  },
  delete(account) {
    run("secret-tool", ["clear", "service", SERVICE, "account", account])
  },
}

/**
 * The keychain for this platform, or null when there is none.
 *
 * `SCE_NO_KEYCHAIN=1` forces the file, which is what the tests use and what a
 * developer reaches for when a corporate keychain policy gets in the way.
 */
function keychain(): Keychain | null {
  if (process.env.SCE_NO_KEYCHAIN === "1") return null
  if (process.platform === "darwin") return macKeychain
  // Windows has no first-party CLI that can read a secret back out, so it uses
  // the file store — DPAPI would need a native module, which this package does
  // not carry.
  if (process.platform === "linux") return secretTool
  return null
}

function parse(raw: string): StoredCredential | null {
  try {
    const parsed = storedCredentialSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Load the credential for a server.
 *
 * Keychain first, then file — and a keychain hit wins even if the file also has
 * one, so an old file left behind by an earlier version cannot shadow a fresh
 * login.
 */
export function loadCredential(serverUrl: string): LoadedCredential | null {
  const account = credentialKey(serverUrl)

  const ring = keychain()
  if (ring !== null) {
    const raw = ring.get(account)
    const credential = raw === null ? null : parse(raw)
    if (credential !== null) return { credential, backend: "keychain" }
  }

  const fromFile = readCredential(serverUrl)
  return fromFile === null ? null : { credential: fromFile, backend: "file" }
}

/** Save a credential, preferring the keychain and falling back to the file. */
export function saveCredential(serverUrl: string, credential: StoredCredential): StorageBackend {
  const account = credentialKey(serverUrl)
  const ring = keychain()

  if (ring !== null && ring.set(account, JSON.stringify(credential))) {
    // Belt and braces: if a file copy exists from before, drop it rather than
    // leaving a stale secret on disk that nothing will ever refresh.
    clearCredential(serverUrl)
    return "keychain"
  }

  writeCredential(serverUrl, credential)
  return "file"
}

/** Forget a credential from both stores. Logging out has to be thorough. */
export function forgetCredential(serverUrl: string): void {
  keychain()?.delete(credentialKey(serverUrl))
  clearCredential(serverUrl)
}

/** Where a credential would be written, for messages the user can act on. */
export function describeStorage(): string {
  return keychain() === null ? credentialsPath() : "the OS keychain"
}
