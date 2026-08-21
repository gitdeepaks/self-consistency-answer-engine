import { PrismaLibSql } from "@prisma/adapter-libsql"
import { PrismaClient } from "../generated/client.ts"
import { resolveDatabaseUrl } from "./url.ts"

export type { PrismaClient } from "../generated/client.ts"
export { Prisma } from "../generated/client.ts"

function createPrismaClient(): PrismaClient {
  const url = resolveDatabaseUrl()
  const adapter = new PrismaLibSql({
    url,
    // Turso deployments supply an auth token; local files ignore it.
    authToken: process.env.TURSO_AUTH_TOKEN,
  })
  return new PrismaClient({ adapter })
}

// Bun's --watch reloads the module graph on every save; without this guard each
// reload would leak a fresh connection pool.
const globalForPrisma = globalThis as unknown as { __scePrisma?: PrismaClient }

export const prisma: PrismaClient = globalForPrisma.__scePrisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__scePrisma = prisma
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
  globalForPrisma.__scePrisma = undefined
}
