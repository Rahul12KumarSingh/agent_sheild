# Built by Cloud Build from source (`gcloud run deploy --source .`), so no local Docker is needed.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY console ./console
# Only what the server serves: the full `npm run build` also packages the Claude Code plugin,
# which needs scripts/ and is not part of the image.
RUN npx tsup && npx vite build --config console/vite.config.ts --logLevel warn

# The server bundle is self-contained: no node_modules in the runtime image.
# Same layout as the repository: dist/ next to scenarios/ and policies/.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/dist/server.js ./dist/server.js
COPY --from=build /app/dist/console ./dist/console
COPY scenarios ./scenarios
COPY policies ./policies
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
