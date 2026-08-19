FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS runtime
ENV NODE_ENV=production \
    CINEMA_CHROME_EXECUTABLE=/usr/bin/chromium \
    CINEMA_CHROME_PROFILE_DIR=/tmp/japan-cinema-browser-mcp/chrome-profile \
    CINEMA_HEADLESS=true \
    XDG_CONFIG_HOME=/tmp/japan-cinema-browser-mcp/xdg-config \
    XDG_CACHE_HOME=/tmp/japan-cinema-browser-mcp/xdg-cache
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium chromium-sandbox ca-certificates \
    && chromium --version \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system mcp \
    && useradd --system --gid mcp --create-home --home-dir /home/mcp mcp \
    && mkdir -p /tmp/japan-cinema-browser-mcp/chrome-profile /tmp/japan-cinema-browser-mcp/xdg-config /tmp/japan-cinema-browser-mcp/xdg-cache \
    && chown -R mcp:mcp /tmp/japan-cinema-browser-mcp /home/mcp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER mcp
EXPOSE 8080
CMD ["node", "dist/index.js", "--http"]
