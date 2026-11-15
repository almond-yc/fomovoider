# Built from the repository root so the adapter compiles against the
# connector contract in src/connectors/types.ts.
FROM node:24-alpine AS build
WORKDIR /app/bridge/adapter
COPY bridge/adapter/package.json bridge/adapter/package-lock.json ./
RUN npm ci
COPY src/connectors/types.ts /app/src/connectors/types.ts
COPY bridge/adapter/tsconfig.json ./
COPY bridge/adapter/src ./src
RUN npx tsc -p .

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/bridge/adapter/dist ./dist
COPY bridge/adapter/package.json ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/bridge/adapter/src/main.js"]
