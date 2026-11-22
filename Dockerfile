# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TINYRSS_DB=/data/tinyrss.db \
    TINYRSS_EXPECT_VOLUME=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# `tinyrss <command>` shortcut for use from a container shell (e.g. Coolify's Terminal tab).
# /data is created owned by the runtime user, so a fresh named volume inherits that ownership.
RUN printf '#!/bin/sh\nexec bun /app/src/cli.ts "$@"\n' > /usr/local/bin/tinyrss \
 && chmod 755 /usr/local/bin/tinyrss \
 && mkdir -p /data \
 && chown 1000:1000 /data

USER 1000:1000
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "src/server.ts"]
