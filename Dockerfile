# syntax=docker/dockerfile:1
#
# tap — LLM gateway. Multi-stage build for the pnpm workspace (web SPA + server).
# Cluster nodes are amd64; the Woodpecker pipeline builds linux/amd64.
#
# Layout in the runtime image:
#   /app/server/dist     compiled Fastify server (entry: server/dist/index.js)
#   /app/web/dist        built SPA (served by the server under /__gateway/app/)
#   /app/{,server/}node_modules  pruned production deps
#   /data                mutable state (config.json + logs/) — TAP_DATA_DIR, a volume

# ---- builder: all deps + build, then prune to prod ----
FROM node:22-bookworm-slim AS builder
ENV CI=1
RUN corepack enable
WORKDIR /src

# In-cluster npm proxy (verdaccio) when the pipeline passes it; public registry
# locally. Woodpecker injects NPM_CONFIG_REGISTRY into steps but NOT into
# `docker build`, so it must arrive as a build-arg (see .woodpecker.yaml).
ARG NPM_CONFIG_REGISTRY=
ENV NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}

# Dependency layer — keyed on manifests + lockfile for cache reuse.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

# Build: web first, then server (server serves web/dist — order matters).
COPY . .
RUN pnpm build

# Drop dev dependencies; keep only what the server needs at runtime.
RUN pnpm install --prod --frozen-lockfile

# ---- runtime: minimal, non-root ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    TZ=Asia/Shanghai \
    TAP_DATA_DIR=/data
WORKDIR /app

COPY --from=builder /src/package.json        ./package.json
COPY --from=builder /src/node_modules        ./node_modules
COPY --from=builder /src/server/package.json ./server/package.json
COPY --from=builder /src/server/node_modules ./server/node_modules
COPY --from=builder /src/server/dist         ./server/dist
COPY --from=builder /src/web/dist            ./web/dist

# Mutable state lives on a mounted volume, owned by the unprivileged runtime user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
