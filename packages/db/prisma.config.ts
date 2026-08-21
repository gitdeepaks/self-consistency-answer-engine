import { defineConfig } from "prisma/config"
import { resolveDatabaseUrl } from "./src/url.ts"

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Absolute by construction, so `prisma db push` from any cwd hits the same
    // file the server opens at runtime.
    url: resolveDatabaseUrl(),
  },
})
