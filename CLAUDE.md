# CLAUDE.md

## Project

OptimusHQ — a self-hosted multi-tenant platform for running multiple Claude Code agents across projects. Fork of `goranefbl/optimushq` with Docker agent isolation.

## Workflow

- **Always update `tasks.md` before implementing.** During planning, append new tasks to the Pending section of `tasks.md` with clear descriptions. This is our spec — no implementation without a written task.
- When a task is complete, move it to the Completed section with the commit hash.
- Keep task descriptions concise but specific enough to understand scope without reading the code.
- **Run all tests before marking a feature complete.** Both unit and e2e tests must pass. If test infrastructure doesn't exist yet for the area being changed, add tests as part of the task.

## Stack

- Client: React 18 + Vite + Tailwind CSS
- Server: Express + WebSocket + SQLite
- Shared types in `shared/types.ts`
- Agents spawn via Claude CLI (local) or Docker containers (`AGENT_MODE=docker`)

## Key Paths

- `server/src/claude/` — Agent spawning and context assembly
- `server/src/tools/` — MCP server implementations
- `server/src/mcp/tool-handlers.ts` — MCP tool handler logic
- `server/src/routes/` — REST API endpoints
- `client/src/pages/` — UI pages
- `docker/` — Dockerfiles for platform and agent containers
