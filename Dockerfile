# syntax=docker/dockerfile:1
# Production image (12.2). Portable: no cloud-specific tooling, no database,
# no secrets and no .env inside. Configuration comes from the environment
# (see docs/configuration.md); migrations run as a separate step
# (docs/deployment.md). Do not run more than one backend replica before
# Stage 12.5: the single-instance lock refuses a second one.
ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Exact lockfile install; argon2 uses its bundled prebuilt binary.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
# Code stays root-owned and read-only for the unprivileged runtime user.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# Exec form: Node is PID 1 and receives SIGTERM directly; src/main.ts runs
# the graceful shutdown (bounded by SHUTDOWN_TIMEOUT_MS). Give the
# orchestrator a stop timeout above it (e.g. docker stop -t 15).
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
