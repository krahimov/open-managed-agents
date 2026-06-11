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
RUN pnpm install --frozen-lockfile
RUN pnpm build:console

ENV NODE_ENV=production \
    PORT=8787 \
    CONSOLE_DIR=/app/apps/console/dist

EXPOSE 8787
WORKDIR /app/apps/main-node
CMD ["npx", "tsx", "src/index.ts"]
