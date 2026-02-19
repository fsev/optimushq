# OptimusHQ

A self-hosted multi-tenant platform for running multiple Claude Code agents across projects. Each agent runs in an isolated Docker container with its own tools, credentials, and workspace.

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url> && cd optimushq

# 2. Run setup (checks prereqs, creates .env, builds images, starts platform)
./setup.sh

# 3. Open http://localhost:3001
#    Default login: admin / changeme
```

## Prerequisites

- **Docker** with Compose v2 (`docker compose`)
- **Claude CLI** authenticated (`~/.claude/.credentials.json` must exist — run `claude` once locally to set up)
- **Git** configured (`~/.gitconfig`)

## Manual Setup

If you prefer not to use the setup script:

```bash
# 1. Copy and edit the environment file
cp .env.example .env
# Edit .env — set AUTH_PASS, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, DOCKER_GID

# 2. Create the projects directory
mkdir -p ~/projects

# 3. Find your Docker GID
stat -c '%g' /var/run/docker.sock
# Put this value in .env as DOCKER_GID

# 4. Build and start
docker compose up --build -d

# 5. (Optional) Build specialized agent images
docker compose --profile agent-images build
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser → http://localhost:3001            │
│  (React + Vite + Tailwind)                  │
├─────────────────────────────────────────────┤
│  Platform Container (optimushq)             │
│  Express + WebSocket + SQLite               │
│  Spawns agent containers via Docker socket  │
├──────────┬──────────┬───────────────────────┤
│ Agent 1  │ Agent 2  │ Agent N  ...          │
│ (docker) │ (docker) │ (docker)              │
│ Claude   │ Claude   │ Claude CLI            │
│ CLI      │ CLI      │ + tools               │
└──────────┴──────────┴───────────────────────┘
```

- **Platform** serves the UI and API, manages sessions, spawns agent containers
- **Agents** are isolated Docker containers running Claude Code CLI
- Agents communicate back to the platform via an MCP HTTP bridge
- Each agent gets its own workspace mount, credentials, and resource limits
- Containers persist across messages and despawn after 5 min idle

## Agent Images

| Image | Description | Built by default |
|-------|-------------|-----------------|
| `claude-agent-base` | Node 22 + Git + Claude CLI | Yes |
| `claude-agent-node` | + build-essential, python3 | No |
| `claude-agent-python` | + Python 3, pip, venv | No |
| `claude-agent-browser` | + Playwright, Chromium | No |
| `claude-agent-flutter` | + Flutter SDK | No |

Build specialized images:

```bash
docker compose --profile agent-images build
```

Assign images to agents in **Settings > Agents** — each agent can use a different Docker image. Sessions with that agent will spawn in the selected container.

## Configuration

All configuration is via `.env` (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_USER` | `admin` | Login username |
| `AUTH_PASS` | `changeme` | Login password |
| `DOCKER_GID` | — | Docker socket group ID (required) |
| `HOST_PROJECTS_DIR` | `$HOME/projects` | Where project files live on the host |
| `GIT_AUTHOR_NAME` | — | Git name for agent commits |
| `GIT_AUTHOR_EMAIL` | — | Git email for agent commits |
| `AGENT_MODE` | `docker` | Set to `local` to disable containerized agents |
| `AGENT_MEMORY_LIMIT` | `4294967296` | Per-agent memory limit (bytes) |
| `AGENT_CPU_LIMIT` | `2` | Per-agent CPU cores |
| `AGENT_PIDS_LIMIT` | `512` | Per-agent process limit |
| `AGENT_RUNTIME` | — | Set to `sysbox-runc` for Docker-in-Docker |
| `AGENT_DOCKER_ACCESS` | — | Set to `socket` to give agents Docker access |

## Operations

```bash
# Start
docker compose up -d

# View logs
docker compose logs -f optimushq

# Rebuild after code changes
docker compose up --build -d

# Stop
docker compose down

# Reset database (data volume)
docker compose down -v
```

## Development

```bash
# Install dependencies
npm install

# Run server + client locally (no Docker agents)
AGENT_MODE=local npm run dev

# Run tests
cd server && npx vitest run
```

## Key Paths

| Path | Description |
|------|-------------|
| `server/src/claude/` | Agent spawning, Docker lifecycle, context assembly |
| `server/src/mcp/` | MCP tool handler logic |
| `server/src/routes/` | REST API endpoints |
| `client/src/pages/` | UI pages |
| `docker/platform/` | Platform Dockerfile |
| `docker/agent/` | Agent Dockerfiles (base, node, python, browser, flutter) |
| `shared/types.ts` | Shared TypeScript interfaces |
