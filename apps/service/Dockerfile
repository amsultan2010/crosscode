# Container image for the Crosscode coordination service.
#
# The service holds long-lived WebSocket connections (apps/daemon/src/ws-client.ts keeps
# one open per replica), so it needs a host that runs a persistent process -- serverless
# platforms terminate the connection between requests. Any container host works: Fly,
# Railway, Render, Cloud Run, or a plain Docker daemon on a VPS.
#
# Build from the REPO ROOT, not this directory, so the workspace packages resolve:
#   docker build -f apps/service/Dockerfile -t crosscode-service .

FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# pnpm needs every workspace member's package.json present to resolve the lockfile graph,
# and only the manifests, so that a source edit does not invalidate the install layer.
#
# They are collected by a find rather than listed one per line. The list was previously
# written out by hand and named apps/vscode-extension, which was deleted in the CLI-only
# pass -- COPY of a missing path is a hard error, so every build of this image failed from
# that merge until this was fixed. A find cannot go stale that way: add or remove a workspace
# member and the image follows. This stage copies the whole repo, so it re-runs on any
# change, but it is only a file copy; the expensive `pnpm install` below keys off the
# manifests alone and still caches.
FROM base AS manifests
WORKDIR /src
COPY . .
RUN mkdir /manifests && \
    find . -name node_modules -prune -o -name package.json -print \
      | while read -r manifest; do mkdir -p "/manifests/$(dirname "$manifest")" && cp "$manifest" "/manifests/$manifest"; done && \
    cp pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json /manifests/

FROM base AS runtime
WORKDIR /app
COPY --from=manifests /manifests ./

# --ignore-scripts: no member package needs a postinstall to run the service, and skipping
# them avoids pulling build toolchains into the image.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages ./packages
COPY apps/service ./apps/service

# The service runs straight from TypeScript via tsx, matching `pnpm service` in development
# and the "start" script in apps/service/package.json.
ENV NODE_ENV=production

# Bind every interface: the platform's edge terminates TLS and forwards to the container,
# which is what CROSSCODE_TRUST_PROXY_TLS attests to. Without that flag the service refuses
# to bind a non-loopback address without a certificate of its own.
ENV CROSSCODE_SERVICE_HOST=0.0.0.0
ENV CROSSCODE_SERVICE_PORT=8080
EXPOSE 8080

# DATABASE_URL, SUPABASE_URL, CROSSCODE_ALLOWED_ORIGINS and CROSSCODE_TRUST_PROXY_TLS are
# supplied by the host as secrets -- never baked into the image.
CMD ["pnpm", "--filter", "@crosscode/service", "start"]
