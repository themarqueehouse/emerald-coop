# Relay container. Works as-is on Railway, Render, Fly.io and anything else
# that runs a Dockerfile.
#
# The relay is stateless: it pairs two players and forwards frames. The save
# lives on player 1's device, so there is nothing here to persist and nothing
# to back up.

FROM node:22-alpine

WORKDIR /app

# Copy manifests first so the dependency layer is cached across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY protocol.js server.js ./

# Hosts inject $PORT; the server reads it and falls back to 8787.
ENV PORT=8787
EXPOSE 8787

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

CMD ["node", "server.js"]
