# Built by Cloud Build from source (`gcloud run deploy --source .`), so no local Docker is needed.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# The server bundle is self-contained: no node_modules in the runtime image.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/dist/server.js ./server.js
USER node
EXPOSE 8080
CMD ["node", "server.js"]
