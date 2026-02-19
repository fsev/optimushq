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

### Default to Docker Mode
Docker mode is the primary runtime. `AGENT_MODE` no longer needs to be set — Docker is the default. Set `AGENT_MODE=local` to use bare-metal mode.

- [x] Change `AGENT_MODE` default from `local` to `docker` — `isDockerMode()` now returns `process.env.AGENT_MODE !== 'local'`
- [x] Update `context.ts` and `index.ts` to use `!== 'local'` pattern consistently
- [x] Remove explicit `AGENT_MODE=docker` from `docker-compose.yml` (now redundant)
- [x] Add startup Docker health check — verifies socket, image, and network on boot; exits with clear remediation on failure
- [x] Surface Docker errors in the UI — enhanced error messages for "No such image" and socket failures
- [x] Add `/api/health` endpoint with Docker status: `{ ok, mode, docker: { socketConnected, imageAvailable, imageName, networkExists } }`
- [x] Change default image from `claude-agent-react` to `claude-agent-base`
- [x] Move agent Dockerfile to `docker/agent/base/Dockerfile`
- [x] Set up vitest test infrastructure (config, test script, `__tests__` directory)
- [x] Add tests for `isDockerMode()` and `checkDockerHealth()`

### Per-Agent Docker Images
Each agent persona can specify which Docker image it runs in. Images are resolved in priority order: explicit param > agent's `docker_image` > project's `agent_image` > env default > `claude-agent-base`.

- [x] Add `docker_image` column to agents table (DB migration in `schema.ts`)
- [x] Add `docker_image` to `Agent` type in `shared/types.ts`
- [x] Update agent CRUD routes — `docker_image` in POST/PUT, `GET /images` endpoint
- [x] Update image resolution chain in `spawn.ts` — agent > project > env > default
- [x] Add `validateImageExists()` — checks image before spawning, surfaces clear error if missing
- [x] Create per-stack Dockerfiles: `base`, `node`, `python`, `browser`, `flutter`
- [x] Update `docker-compose.yml` with build-only services for each image
- [x] Update Agent UI — image dropdown in create/edit form, image badge on agent cards
- [x] Add `create_agent_image` MCP tool — builds custom images from base + packages via Docker API
- [x] Add image resolution priority tests

### Git Worktree Isolation for Concurrent Sessions
When multiple write sessions target the same project, each gets its own git worktree for isolated file changes. Explore sessions share the main checkout.

- [x] Create `server/src/claude/worktree.ts` — `needsWorktree`, `createWorktree`, `removeWorktree`, `getSessionWorkPath`, `cleanupStaleWorktrees`
- [x] Add `worktree_path` column to sessions table (DB migration in `schema.ts`)
- [x] Add `worktree_path` to `Session` type in `shared/types.ts`
- [x] Integrate worktree creation at spawn time in `ws/handler.ts` — checks `needsWorktree()`, creates if needed, stores path
- [x] Update `context.ts` to use `COALESCE(s.worktree_path, p.path)` for effective project path
- [x] Update all git routes to accept `?session_id=` and use worktree path via `getWorkingDir()`
- [x] Update `useGit` hook to accept optional `sessionId` and pass on all API calls
- [x] Update `SourceControl` component to accept and forward `sessionId`
- [x] Add worktree cleanup on session DELETE and status → `done`
- [x] Auto-append `.worktrees` to project `.gitignore`
- [x] Skip worktree for explore mode and single-session projects
- [x] Add tests for worktree lifecycle (create, remove, isolation, fallback)

### Key Files
- `docker-compose.yml` — Multi-service stack (platform, agent images, chrome)
- `docker/platform/Dockerfile` — Express/WebSocket server container
- `docker/agent/base/Dockerfile` — Base agent container (Node 22 + git + Claude CLI)
- `docker/agent/{node,python,browser,flutter}/Dockerfile` — Specialized agent images
- `server/src/claude/docker-spawn.ts` — Container spawn, health check, image validation
- `server/src/claude/spawn.ts` — Agent spawning with Docker/local mode detection and image resolution
- `server/src/claude/worktree.ts` — Git worktree lifecycle management
- `server/src/claude/context.ts` — System prompt assembly with worktree-aware paths
- `server/src/ws/handler.ts` — WebSocket handler with worktree integration at spawn time
- `server/src/routes/git.ts` — Git operations with session-aware working directory
- `server/src/routes/sessions.ts` — Session CRUD with worktree cleanup
- `server/src/mcp/tool-handlers.ts` — MCP tools including `create_agent_image`
- `client/src/components/agents/AgentManager.tsx` — Agent UI with image selector
- `client/src/hooks/useGit.ts` — Git hook with session-aware API calls
- `client/src/components/git/SourceControl.tsx` — Source control UI with session support

### Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_MODE` | Set to `local` to disable Docker agents | (docker) |
| `AGENT_DEFAULT_IMAGE` | Docker image for agent containers | `claude-agent-base` |
| `AGENT_MEMORY_LIMIT` | Memory limit per agent container | 4 GB |
| `AGENT_CPU_LIMIT` | CPU limit per agent container | 2 CPUs |
| `AGENT_PIDS_LIMIT` | PID limit per agent container | 512 |
| `AGENT_DOCKER_ACCESS` | Set to `socket` to mount Docker socket into agents | (none) |
| `AGENT_RUNTIME` | Set to `sysbox-runc` for isolated Docker-in-Docker | (default) |
| `PROJECTS_ROOT` | Root path for project directories | `~/projects` |

## Pending

(none)
