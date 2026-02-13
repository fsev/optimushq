# Stage 1 — Build
FROM node:22-slim AS build

# Install build tools for better-sqlite3 native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY shared/package.json shared/

RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Stage 2 — Runtime
FROM node:22-slim

# Install runtime dependency for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and dependencies from build stage
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/client/package.json ./client/
COPY --from=build /app/server/dist/ ./server/dist/
COPY --from=build /app/client/dist/ ./client/dist/
COPY --from=build /app/shared/ ./shared/
COPY --from=build /app/bin/ ./bin/
COPY --from=build /app/node_modules/ ./node_modules/

# Create data directory for SQLite volume mount
RUN mkdir -p /app/data && chown node:node /app/data

ENV PROJECT_DB_PATH=/app/data/chat.db

EXPOSE 3001

USER node

CMD ["node", "bin/cli.js"]
