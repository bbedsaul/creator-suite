# syntax=docker/dockerfile:1
#
# Poster backend image. One image, two entrypoints (D-022): the API container
# uses the default CMD, the worker container overrides it with
# `node dist/worker/index.js`.
#
# Build context is the REPO ROOT, not this directory, because a workspace
# service needs the root manifests and its workspace dependencies:
#   docker build -f services/poster/Dockerfile -t poster-service .

FROM node:24-alpine AS base
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
# Manifest only, and only so pnpm can resolve the workspace graph: the service
# devDepends on the reference consumer for its webhook integration tests. `--prod`
# on the deploy step keeps it out of the runtime image, and its *source* is never
# copied — a tool has no business in a service image (D-079).
COPY tools/webhook-sink/package.json tools/webhook-sink/
COPY services/poster/package.json services/poster/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter '@suite/poster-service...'

# --- build -------------------------------------------------------------------
# Only the service and the backend packages it actually depends on are copied,
# so the image cannot accidentally contain frontend code.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/poster-contract packages/poster-contract
COPY packages/server-core packages/server-core
COPY services/poster services/poster
# The three packages are named explicitly rather than using pnpm's
# `@suite/poster-service...` closure. That closure follows **dev** dependencies
# too, so it tried to build @suite/poster-client and @suite/webhook-sink — a
# frontend SDK and a reference consumer, neither of which belongs in a backend
# image and neither of whose sources are copied here. The build broke the moment
# the service gained those devDependencies, and stayed broken because nothing
# built this image in CI; `image` in .github/workflows/ci.yml now does (D-103).
RUN pnpm --filter '@suite/poster-contract' \
         --filter '@suite/server-core' \
         --filter '@suite/poster-service' build \
    && pnpm --filter '@suite/poster-service' --prod --legacy deploy /out

# --- runtime -----------------------------------------------------------------
FROM node:24-alpine AS runtime
# ffmpeg brings ffprobe, which /v1/media uses to read duration and dimensions.
# It comes from apk rather than an npm package because the packaged binaries have
# no musl build (D-062); the Clipper will need the full ffmpeg here regardless.
RUN apk add --no-cache ffmpeg
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
