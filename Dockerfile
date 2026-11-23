# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4

# All dependencies are pure JavaScript, so they are installed once on the build machine's own
# platform and copied into every target platform. The final stage has no RUN steps, which means
# multi-arch builds (amd64 + arm64) need no emulation. If a dependency with native code is ever
# added, move `bun install` into the final stage.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# `tinyrss <command>` shortcut for use from a container shell (e.g. Coolify's Terminal tab),
# and an empty /data skeleton that is copied in owned by the runtime user.
RUN printf '#!/bin/sh\nexec bun /app/src/cli.ts "$@"\n' > /tinyrss && mkdir /data-skeleton

FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app

LABEL org.opencontainers.image.title="tinyrss" \
      org.opencontainers.image.description="Single-user RSS reader with a Google Reader compatible API" \
      org.opencontainers.image.source="https://github.com/idan/tinyrss" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TINYRSS_DB=/data/tinyrss.db \
    TINYRSS_EXPECT_VOLUME=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build --chmod=755 /tinyrss /usr/local/bin/tinyrss
# A fresh named volume mounted at /data inherits this ownership.
COPY --from=build --chown=1000:1000 /data-skeleton /data
COPY package.json LICENSE ./
COPY src ./src

USER 1000:1000
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["tinyrss", "healthcheck"]

CMD ["bun", "src/server.ts"]
