# syntax=docker/dockerfile:1
#
# Poster backend image. One image, two entrypoints (D-022): the API container
# uses the default CMD, the worker container overrides it with
# `node dist/worker/index.js`.
#
# Build context is the REPO ROOT, not this directory, because a workspace
# service needs the root manifests and its workspace dependencies:
#   docker build -f services/poster/Dockerfile -t poster-service .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /repo

# --- dependencies ------------------------------------------------------------
# Manifests only, so a source-only change does not re-resolve the dependency
# graph.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/poster-client/package.json packages/poster-client/
COPY packages/poster-contract/package.json packages/poster-contract/
COPY packages/server-core/package.json packages/server-core/
COPY packages/ui/package.json packages/ui/
COPY services/poster/package.json services/poster/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter '@suite/poster-service...'

# --- build -------------------------------------------------------------------
# Only the service and the backend packages it actually depends on are copied,
# so the image cannot accidentally contain frontend code.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/server-core packages/server-core
COPY services/poster services/poster
RUN pnpm --filter '@suite/poster-service...' build \
    && pnpm --filter '@suite/poster-service' --prod --legacy deploy /out

# --- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# The worker container runs the same image with: node dist/worker/index.js
CMD ["node", "dist/api/index.js"]
