FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY apps/control/src ./apps/control/src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/build/control ./build/control
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
USER 10001:10001
ENTRYPOINT ["node", "/app/build/control/launcher.js"]
