FROM node:22-bookworm-slim AS build
WORKDIR /plugin
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ghcr.io/headlamp-k8s/headlamp:v0.46.0
COPY --from=build /plugin/package.json /headlamp/plugins/job-console/package.json
COPY --from=build /plugin/dist/ /headlamp/plugins/job-console/
