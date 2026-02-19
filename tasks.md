# Tasks

## Completed

### Docker Agent Isolation
Spawn each Claude agent session as an isolated Docker sibling container instead of a local CLI process. Platform talks to the Docker socket via `dockerode` to create/manage agent containers alongside itself.

- [x] Spawn agent sessions as Docker sibling containers via dockerode (`268f27f`)
- [x] Harden Docker agent containers: credential isolation, resource limits (CPU/memory/PIDs), socket control, MCP bridge (`bc7831a`)
- [x] Add Dockerfiles for platform and agent containers (`cb534e9`)
- [x] Fix read-only `.claude` mount preventing platform startup (`efbcadf`)
- [x] Make projects root path configurable via `PROJECTS_ROOT` env var (`d0bf6e1`)
- [x] Build agent image alongside platform in `docker compose up --build` (`26c782e`)
- [x] Fix Docker agent pathing and MCP tool resolution issues (`eb9bf31`)

### Key Files
- `docker-compose.yml` — 3-service stack (platform, agent, chrome)
- `docker/platform/Dockerfile` — Express/WebSocket server container
- `docker/agent/Dockerfile` — Lightweight agent container image
- `server/src/claude/docker-spawn.ts` — Core container spawn logic with host path translation and resource limits
- `server/src/claude/mcp-proxy.ts` — Proxies MCP tool calls from agent containers to the platform
- `server/src/routes/mcp-bridge.ts` — HTTP bridge endpoint for cross-container MCP communication
- `server/src/mcp/tool-handlers.ts` — Extracted MCP tool handler logic (refactored out of project-manager-mcp.ts)

### Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_MODE` | Set to `docker` to enable containerized agents | (local) |
| `AGENT_DEFAULT_IMAGE` | Docker image for agent containers | `claude-agent-react` |
| `AGENT_MEMORY_LIMIT` | Memory limit per agent container | 4 GB |
| `AGENT_CPU_LIMIT` | CPU limit per agent container | 2 CPUs |
| `AGENT_PIDS_LIMIT` | PID limit per agent container | 512 |
| `AGENT_DOCKER_ACCESS` | Set to `socket` to mount Docker socket into agents | (none) |
| `AGENT_RUNTIME` | Set to `sysbox-runc` for isolated Docker-in-Docker | (default) |
| `PROJECTS_ROOT` | Root path for project directories | `~/projects` |

## Pending

_(none yet)_
