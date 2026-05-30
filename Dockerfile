FROM node:24-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm test
RUN npm run build

FROM node:24-alpine AS runtime

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

CMD ["node", "dist/server/index.js"]
