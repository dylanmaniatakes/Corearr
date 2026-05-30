FROM node:24-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
ARG RUN_TESTS=false
RUN if [ "$RUN_TESTS" = "true" ]; then npm test; else echo "Skipping npm test during image build"; fi
RUN npm run build

FROM node:24-alpine AS runtime

LABEL org.opencontainers.image.title="Corearr" \
      org.opencontainers.image.description="Core Radio indexer and Lidarr bridge" \
      org.opencontainers.image.source="https://github.com/DylanManiatakes/Corearr" \
      org.opencontainers.image.url="https://github.com/DylanManiatakes/Corearr"

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads \
    STATIC_DIR=/app/client/dist

WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache 7zip
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/client/dist ./client/dist

RUN mkdir -p /data /downloads && chown -R node:node /data /downloads /app
USER node

VOLUME ["/data", "/downloads"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
