# Weltari — multi-arch image (FINAL item 12: Docker on ghcr is the primary
# packaging). Notify-and-let-host-pull: WELTARI_UPDATE_NOTIFY_ONLY=1 — the
# release check announces updates, apply always 409s; the host pulls a new
# image instead. Exit-code contract: 3 = corrupt_state — do NOT blindly
# restart (use `restart: on-failure` with care; see docs/packaging.md).
FROM node:24.14.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY packages ./packages
COPY apps ./apps
COPY tests ./tests
RUN npm run build && npm prune --omit=dev

FROM node:24.14.1-bookworm-slim
ENV NODE_ENV=production \
    WELTARI_HOST=0.0.0.0 \
    WELTARI_UPDATE_NOTIFY_ONLY=1 \
    WELTARI_DB_PATH=/data/weltari.sqlite \
    WELTARI_IMAGES_DIR=/data/images \
    WELTARI_PLUGINS_DIR=/app/plugins \
    WELTARI_VERSIONS_DIR=/data/versions \
    PORT=7777
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=build /app/packages/plugin-sdk/package.json ./packages/plugin-sdk/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY plugins ./plugins
# The baked update-verification PUBLIC key: cosmetic here (the image runs
# notify-only — hosts pull new images), but every shipped layout carries it
# at the app root for consistency (see docs/update.md).
COPY minisign.pub ./minisign.pub
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7777
CMD ["node", "apps/server/dist/main.js"]
