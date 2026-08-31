FROM oven/bun:1.4.0 AS development-dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile


FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY --from=development-dependencies /app/node_modules ./node_modules

COPY package.json bun.lock ./
COPY server.js ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY data ./data

RUN npm run build


FROM oven/bun:1.4.0 AS production-dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    RANKED_ENABLED=false

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/bun.lock /app/server.js ./
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/data ./data
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node \
    /app/scripts/run-migrations.js \
    /app/scripts/import-sheets-export.js \
    /app/scripts/verify-postgres-import.js \
    ./scripts/

# The same image runs the Northflank migration job. Playwright is a development
# dependency and neither it nor downloaded browser binaries belong in runtime.
RUN test -x /app/node_modules/.bin/node-pg-migrate \
    && test ! -e /app/node_modules/playwright \
    && test ! -e /app/node_modules/playwright-core \
    && test ! -e /app/node_modules/@playwright \
    && test ! -e /root/.cache/ms-playwright \
    && test ! -e /home/node/.cache/ms-playwright

USER node

EXPOSE 3000
STOPSIGNAL SIGTERM

CMD ["node", "server.js"]
