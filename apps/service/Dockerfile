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

WORKDIR /app

# The workspace manifests alone, so a dependency install caches independently of source
# edits. pnpm needs every member package's package.json present to build the lockfile graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/service/package.json ./apps/service/
COPY packages/core/package.json ./packages/core/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/git/package.json ./packages/git/
COPY packages/test-fixtures/package.json ./packages/test-fixtures/
COPY apps/cli/package.json ./apps/cli/
COPY apps/daemon/package.json ./apps/daemon/
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY apps/vscode-extension/package.json ./apps/vscode-extension/
COPY apps/docs-site/package.json ./apps/docs-site/

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
