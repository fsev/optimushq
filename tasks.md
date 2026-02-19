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

### Git Worktree Isolation for Concurrent Sessions
When multiple sessions target the same project, they currently share the same working directory. Two write sessions will conflict — edits from one agent get overwritten by the other. Use git worktrees to give each session its own isolated checkout.

- [ ] On session start, create a git worktree for the session (e.g., `.worktrees/<session-id>`) on a new branch
- [ ] Update `spawn.ts` and `docker-spawn.ts` to set `cwd` / bind mount to the worktree path instead of the main project dir
- [ ] Update `context.ts` to pass the worktree path instead of the project root
- [ ] Handle worktree cleanup on session end/delete — prune worktrees and delete branches for closed sessions
- [ ] Skip worktree creation for read-only (Explore) sessions — they can safely share the main checkout
- [ ] Update git routes (`routes/git.ts`) and SourceControl UI to be worktree-aware (show correct branch, status for the session's worktree)
- [ ] Handle the "first session" / "only session" case — no worktree needed if only one active write session exists on a project
- [ ] Add tests for worktree lifecycle (create, use, cleanup)

### Default to Docker Mode
Docker mode is our primary runtime. Switch the default from local to docker so `AGENT_MODE` doesn't need to be explicitly set.

- [ ] Change `AGENT_MODE` default from `local` to `docker` in `spawn.ts` (`isDockerMode()`)
- [ ] Update `docker-compose.yml` — remove the explicit `AGENT_MODE=docker` env var (now redundant)
- [ ] Update README and configuration table in `tasks.md` to reflect the new default
- [ ] Add `AGENT_MODE=local` escape hatch documentation for anyone who needs bare-metal mode
- [ ] Add startup Docker health check — on server boot, verify Docker socket is accessible and agent image exists. If either fails, log a clear error with remediation steps (not just a silent fallback to local)
- [ ] Surface Docker errors in the UI — when a container fails to start, send the error back to the chat as a visible system message instead of only logging to server stdout
- [ ] Add a `/health` or status endpoint that reports whether Docker mode is operational (socket connected, image available, network exists)

### Per-Agent Docker Images
Different agents need different toolchains — a dev agent needs Node/Flutter SDKs, a QA agent needs test runners and browsers, a product agent just needs a lightweight shell. Images are configured per agent, not per project, so the same project can run multiple agents with different images.

- [ ] Add `docker_image` column to the `agents` table — each agent persona specifies which image it runs in
- [ ] Add image selector to agent settings UI (dropdown of available images)
- [ ] Update `docker-spawn.ts` to resolve the image from the session's agent instead of the global `AGENT_DEFAULT_IMAGE`
- [ ] Create a base agent Dockerfile (`claude-agent-base`) that all images extend (Claude CLI + common tools), with per-stack Dockerfiles inheriting from it
- [ ] Ship default images: `claude-agent-node` (Node/React/Next), `claude-agent-flutter` (Flutter SDK), `claude-agent-python` (Python/pip), `claude-agent-browser` (Playwright/Puppeteer), `claude-agent-base` (minimal)
- [ ] Add API endpoint to list available agent images from Docker (`docker images` filtered by naming convention, e.g., `claude-agent-*`)
- [ ] Add UI for building new images — user provides a Dockerfile (or picks a base + installs), platform builds it via Docker API and tags it with `claude-agent-<name>`
- [ ] Add an MCP tool (`create_agent_image`) so agents can build new images conversationally — describe what tools you need and the agent writes the Dockerfile and builds it
- [ ] Validate the image exists before session start — if the agent's image is missing, surface a clear error in the UI
- [ ] Allow per-project image override — project settings can pin a default image that overrides the agent's image (for projects where every agent needs the same stack)
