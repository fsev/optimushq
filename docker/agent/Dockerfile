FROM node:22-slim

# Install git (agents perform git operations)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Ensure writable .claude directory for the node user
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude

USER node

WORKDIR /workspace
