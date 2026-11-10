# OpenHarness node stack — API + console served by one process.
#
# Build:  docker build -t openharness .
# Run:    docker run -p 8787:8787 --env-file .env.production openharness
#
# The node backend (apps/main-node) is the deploy target: webhooks, skills,
# session work queue, and the console UI (CONSOLE_DIR) all live here. The
# Cloudflare worker variant is a separate deploy path and lacks these.
FROM node:22-slim

# git: sandbox subprocess sessions clone/diff repos. ca-certificates: TLS to
# Anthropic / Daytona / webhook receivers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned by the repo's packageManager field.
RUN corepack enable

WORKDIR /app
COPY . .
# better-sqlite3 downloads a prebuilt binary from GitHub during install and
# falls back to compiling from source, which this image can't do (no
# python/make/g++). A timed-out download failed a prod deploy, so retry
# the install rather than ship a compiler toolchain in the runtime image.
RUN for attempt in 1 2 3; do \
      pnpm install --frozen-lockfile && exit 0; \
      echo "pnpm install failed (attempt $attempt), retrying" >&2; sleep $((attempt * 15)); \
    done; exit 1

# Console is a Vite build — VITE_* vars are baked in at BUILD time, not
# read at runtime. Railway exposes service variables to Dockerfile builds
# as build args; declaring the ARG here is what lets it reach the build.
# Leave unset for the classic better-auth login screens.
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}
RUN pnpm build:console

ENV NODE_ENV=production \
    PORT=8787 \
    CONSOLE_DIR=/app/apps/console/dist

EXPOSE 8787
WORKDIR /app/apps/main-node
CMD ["npx", "tsx", "src/index.ts"]
