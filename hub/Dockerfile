# syntax=docker/dockerfile:1.7
# Software Factory Hub image. Build from the REPO ROOT:
#   docker build -f hub/Dockerfile -t REGISTRY/software-factory-hub:VERSION .
# Contains the application only: no PostgreSQL, no Redis, no secrets, no dev dependencies.

ARG NODE_VERSION=24
ARG PNPM_VERSION=12.23.0

# ---- build: install the hub's dependencies from the frozen lockfile and compile ----
FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
ENV CI=true
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY hub/package.json hub/
# web/ is a workspace member; only its manifest is needed so the lockfile still matches.
COPY web/package.json web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter software-factory-hub...
COPY hub/ hub/
RUN pnpm --filter software-factory-hub build \
 && pnpm --filter software-factory-hub --prod deploy /out   # /out: prod node_modules + built dist (incl. migrations)

# ---- runtime: distroless, non-root, no shell or package manager ----
FROM gcr.io/distroless/nodejs${NODE_VERSION}-debian12:nonroot AS runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="software-factory-hub" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="https://github.com/Nikorag/software-factory"
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /out/package.json ./package.json
COPY --from=build --chown=nonroot:nonroot /out/dist ./dist
USER nonroot
EXPOSE 8080
# `node` is the distroless entrypoint, so this runs `node dist/cli.js serve`. Node is PID 1 and handles
# SIGTERM itself (graceful drain). Override the args with `migrate` for the migration Job.
CMD ["dist/cli.js", "serve"]
