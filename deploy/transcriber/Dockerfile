# syntax=docker/dockerfile:1
# Decision 0012: the YapArena transcriber agent for LiveKit Cloud. The build
# context is the directory that scripts/stage-transcriber.ts prepares; deploy it
# with `lk agent deploy <dir>`. LiveKit injects LIVEKIT_URL, LIVEKIT_API_KEY and
# LIVEKIT_API_SECRET at runtime; the other settings are agent secrets.
# Pinned by digest; Dependabot proposes each new digest of this tag.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
# The agent's Rust core reads the system trust store.
RUN apt-get update && apt-get upgrade -y && \
    apt-get install --no-install-recommends -y ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
# .npmrc makes npm refuse dependency install scripts that allowScripts hasn't reviewed.
COPY package.json package-lock.json .npmrc ./
# The root lockfile pins the agent packages as development dependencies, so
# the web image never installs them.
RUN npm ci
COPY tsconfig.json tsconfig.transcriber.json ./
COPY src ./src
RUN npx tsc --project tsconfig.transcriber.json
# Keep only the packages the agent loads and their dependencies, at the
# lockfile's versions; the web app's and the build tools' packages stay out.
COPY scripts/transcriber-runtime-modules.ts ./scripts/
RUN node scripts/transcriber-runtime-modules.ts /runtime

FROM base
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home /app --shell /sbin/nologin \
    --uid "${UID}" appuser
WORKDIR /app
COPY --from=build --chown=appuser:appuser /runtime/node_modules ./node_modules
COPY --from=build --chown=appuser:appuser /app/dist-transcriber ./dist-transcriber
COPY --chown=appuser:appuser package.json ./
USER appuser
ENV NODE_ENV=production
CMD ["node", "dist-transcriber/features/transcription/agent/main.js", "start"]
