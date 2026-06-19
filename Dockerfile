FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app

ARG GIT_COMMIT
ARG RUYI_GIT_COMMIT

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN bun run typecheck
RUN bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --from=build /app/dist ./dist

CMD ["bun", "dist/main.js"]
