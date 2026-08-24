import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../generated/client.ts"
import { resolveDatabaseUrl } from "./url.ts"

export type { PrismaClient } from "../generated/client.ts"
export { Prisma } from "../generated/client.ts"

// Bun's --watch reloads the module graph on every save; without this guard each
// reload would leak a fresh connection pool. Declared rather than asserted, so
// the global stays typed.
declare global {
  // `var` is what attaches a name to globalThis's type; let/const do not.
  var __scePrisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: resolveDatabaseUrl() })
  return new PrismaClient({ adapter })
}

export const prisma: PrismaClient = globalThis.__scePrisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") {
  globalThis.__scePrisma = prisma
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
  globalThis.__scePrisma = undefined
}
