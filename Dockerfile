# ---- Self-Consistency Answer Engine — API server ---------------------------
FROM oven/bun:1.4-slim AS deps
WORKDIR /app

# Copy only manifests first so dependency installs stay cached across code edits.
COPY package.json bun.lock bunfig.toml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json     packages/db/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json    packages/cli/
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
FROM oven/bun:1.4-slim AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma Client is generated code, not a published artifact — build it here.
# Deliberately before NODE_ENV=production: codegen needs no database, and the
# datasource resolver requires a real DATABASE_URL once it believes it is in
# production. Migrations run as the release command, where one is set.
RUN cd packages/db && bunx --bun prisma generate

ENV NODE_ENV=production
EXPOSE 8787
ENV PORT=8787 HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "await fetch('http://127.0.0.1:'+(process.env.PORT??8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "packages/server/src/index.ts"]
