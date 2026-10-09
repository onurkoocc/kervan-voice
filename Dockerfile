# syntax=docker/dockerfile:1
# SPEC §11: dependencies are fetched in a layer that sees only the lock file
# and runs no package scripts; the sources are compiled (and, with
# --target test, tested) in RUN --network=none steps.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN --network=none npm run build

# docker build --target test .
FROM build AS test
COPY vitest.config.ts ./
COPY test ./test
COPY docs ./docs
COPY prompts ./prompts
RUN --network=none npm test

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=7000
WORKDIR /app
RUN --network=none mkdir -p /var/log/kervan && chown node:node /var/log/kervan
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY prompts ./prompts
COPY docs ./docs
USER node
EXPOSE 7000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
