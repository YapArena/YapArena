 # syntax=docker/dockerfile:1

  FROM node:24-bookworm-slim AS base
  RUN apt-get update && apt-get upgrade -y && \
      rm -rf /var/lib/apt/lists/*
  WORKDIR /app

  FROM base AS development
  COPY package.json package-lock.json ./
  RUN npm ci
  COPY . .
  CMD ["npm", "run", "dev"]

  FROM development AS test
  RUN npm run check

  FROM development AS build
  RUN npm run build

  FROM base AS production-dependencies
  ENV NODE_ENV=production
  COPY package.json package-lock.json ./
  RUN npm ci --omit=dev && npm cache clean --force

FROM base AS production
ARG MEDIA_WORKER_TOOLS=false
# FFmpeg brings in libraries the base image lacks (libssl3 among them). Upgrading after the
# install keeps every package at Debian's current security release when this layer builds.
RUN if [ "$MEDIA_WORKER_TOOLS" = "true" ]; then \
      apt-get update && apt-get install --yes --no-install-recommends ffmpeg && \
      apt-get upgrade --yes && \
      rm -rf /var/lib/apt/lists/*; \
    elif [ "$MEDIA_WORKER_TOOLS" != "false" ]; then exit 1; fi
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-semi-space-size=4"
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /opt/yarn-v1.22.22 && \
    rm -f /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/start-staging.sh ./scripts/start-staging.sh
COPY --chown=node:node scripts/migrate-database.ts ./scripts/migrate-database.ts
COPY --chown=node:node scripts/provision-database.ts ./scripts/provision-database.ts
COPY --chown=node:node scripts/check-media-storage.js ./scripts/check-media-storage.js
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
  USER node
  EXPOSE 3000
  CMD ["node", "dist/server.js"]
