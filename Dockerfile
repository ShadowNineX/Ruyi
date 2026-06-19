FROM oven/bun:1 AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth=1 https://github.com/ShadowNineX/Ruyi.git .
RUN bun install --frozen-lockfile
RUN bun run typecheck
RUN bun run build

FROM oven/bun:1 AS runtime
WORKDIR /app

COPY --from=build /app/package.json /app/bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --from=build /app/dist ./dist

CMD ["bun", "dist/main.js"]
