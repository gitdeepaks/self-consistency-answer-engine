import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { DB_PACKAGE_DIR } from "./url.ts"

/**
 * Storage for answer bodies too large to keep in a row.
 *
 * Candidate answers and synthesised answers are unbounded in principle, and a
 * multi-hundred-kilobyte TOAST column turns every history listing into a slow
 * query. Anything over the threshold goes to object storage and the row keeps a
 * pointer. Callers never see the difference — the repository hydrates on read.
 */
export interface BlobStore {
  put(key: string, body: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

/** Bodies at or above this many bytes are offloaded. */
export const LARGE_BODY_THRESHOLD_BYTES = readThreshold()

function readThreshold(): number {
  const raw = process.env.LARGE_BODY_THRESHOLD_BYTES?.trim()
  if (!raw) return 32 * 1024
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 32 * 1024
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/

/** Reject anything that could escape the store root or the tenant prefix. */
function assertSafeKey(key: string): void {
  if (!KEY.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`Unsafe blob key: ${JSON.stringify(key)}`)
  }
}

/**
 * Object-store key for one answer body.
 *
 * Tenant-scoped by construction: a signed URL or a bucket policy can be written
 * against the `tenants/<id>/` prefix without trusting application code.
 */
export function blobKey(tenantId: string, runId: string, name: string): string {
  const key = `tenants/${tenantId}/runs/${runId}/${name}`
  assertSafeKey(key)
  return key
}

/**
 * Filesystem-backed store — the local and single-node default.
 *
 * S3/R2 slots in behind the same interface; nothing above this file knows which
 * implementation is in use.
 */
export class FileBlobStore implements BlobStore {
  readonly #root: string

  constructor(root: string = process.env.BLOB_DIR?.trim() || path.join(DB_PACKAGE_DIR, ".blobs")) {
    this.#root = path.resolve(root)
  }

  #path(key: string): string {
    assertSafeKey(key)
    const resolved = path.resolve(this.#root, key)
    if (resolved !== this.#root && !resolved.startsWith(this.#root + path.sep)) {
      throw new Error(`Blob key escapes the store root: ${JSON.stringify(key)}`)
    }
    return resolved
  }

  async put(key: string, body: string): Promise<void> {
    const file = this.#path(key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body, "utf8")
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.#path(key), "utf8")
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true })
  }
}

/** Node errno errors are typed as `unknown` in a catch; parse rather than assert. */
const errnoSchema = z.object({ code: z.string() })

function isNotFound(error: unknown): boolean {
  const parsed = errnoSchema.safeParse(error)
  return parsed.success && parsed.data.code === "ENOENT"
}

let store: BlobStore = new FileBlobStore()

export function blobStore(): BlobStore {
  return store
}

/** Swap the implementation — used by tests and, later, by S3/R2 wiring. */
export function setBlobStore(next: BlobStore): void {
  store = next
}
