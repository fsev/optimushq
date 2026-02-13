/**
 * Shared MCP tool handler logic.
 *
 * Used by both the stdio-based project-manager-mcp (bare-metal) and
 * the HTTP MCP bridge (Docker mode).  All DB access goes through the
 * context object so callers can supply their own connection.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync, existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import http from 'http';

// ---- Types ----------------------------------------------------------------

export interface McpContext {
  userId: string | null;
  sessionId: string | null;
  db: Database.Database;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---- Tool definitions ------------------------------------------------------

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/home/claude/projects';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

/**
 * Resolve a project_id that may be a UUID or a project name.
 * Returns the UUID, or throws if not found.
 */
function resolveProjectId(db: Database.Database, raw: string, userId: string | null): string {
  // Try direct UUID lookup first
  const byId = db.prepare('SELECT id FROM projects WHERE id = ?').get(raw) as { id: string } | undefined;
  if (byId) return byId.id;

  // Fallback: case-insensitive name match (scoped to user if available)
  const query = userId
    ? 'SELECT id FROM projects WHERE LOWER(name) = LOWER(?) AND user_id = ? LIMIT 1'
    : 'SELECT id FROM projects WHERE LOWER(name) = LOWER(?) LIMIT 1';
  const byName = userId
    ? db.prepare(query).get(raw, userId) as { id: string } | undefined
    : db.prepare(query).get(raw) as { id: string } | undefined;
  if (byName) return byName.id;

  throw new Error(`Project not found: ${raw}`);
}

function verifyProjectAccess(db: Database.Database, userId: string | null, projectId: string) {
  if (!userId) return;
  const row = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId) as { user_id: string | null } | undefined;
  if (row && row.user_id && row.user_id !== userId) {
    throw new Error('Access denied: project belongs to another user');
  }
}

function success(id: number | string, text: string, isError = false): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      isError,
    },
  };
}

export const TOOLS = [
  {
    name: 'create_project',
    description: 'Create a new project in the system with a workspace folder on disk. Returns the project ID and path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Project description (optional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'clone_project',
    description: 'Create a new project and clone a git repository into its workspace folder. Returns the project ID and path.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name' },
        git_url: { type: 'string', description: 'Git repository URL to clone' },
        description: { type: 'string', description: 'Project description (optional)' },
      },
      required: ['name', 'git_url'],
    },
  },
  {
    name: 'list_projects',
    description: 'List all projects in the system with their IDs, names, and paths.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'get_project_memory',
    description: 'Read the shared project memory for a project. Project memory persists across all sessions and contains important context like server configuration, startup commands, and recovery steps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'update_project_memory',
    description: 'Update the shared project memory for a project. Use this to save important project context that should persist across sessions, such as: architecture decisions, known issues, working notes, and other context for future sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        summary: { type: 'string', description: 'The full project memory content (replaces existing).' },
      },
      required: ['project_id', 'summary'],
    },
  },
  {
    name: 'get_server_config',
    description: 'Read the server configuration for a project. Server config contains startup commands, dependencies, health checks, and recovery steps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'update_server_config',
    description: 'Update the server configuration for a project. Use this after setting up a new project or changing how the dev server runs. Include: start command, required services (databases, etc.), health check command, and any recovery steps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        server_config: { type: 'string', description: 'Server config content. Include start command, dependencies, health check, and recovery steps.' },
      },
      required: ['project_id', 'server_config'],
    },
  },
  {
    name: 'add_memory_entry',
    description: 'Add a structured memory entry to the cross-project memory system. Use this to record decisions, features, bugs, content, todos, or context that should be searchable across all projects.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Project ID this entry belongs to' },
        category: { type: 'string', enum: ['decision', 'feature', 'bug', 'content', 'todo', 'context'], description: 'Category of the memory entry' },
        title: { type: 'string', description: 'Short title summarizing the entry' },
        content: { type: 'string', description: 'Detailed content of the memory entry' },
        tags: { type: 'string', description: 'JSON array of tag strings (optional)', default: '[]' },
      },
      required: ['project_id', 'category', 'title', 'content'],
    },
  },
  {
    name: 'search_memory',
    description: 'Full-text search across all memory entries in all projects. Use this to find decisions, features, bugs, and context across the entire platform.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (supports FTS5 syntax)' },
        project_id: { type: 'string', description: 'Filter to a specific project (optional)' },
        category: { type: 'string', enum: ['decision', 'feature', 'bug', 'content', 'todo', 'context'], description: 'Filter by category (optional)' },
        limit: { type: 'number', description: 'Max results to return (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_memory_entries',
    description: 'List memory entries for a project, optionally filtered by category. Returns entries in reverse chronological order.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Project ID to list entries for' },
        category: { type: 'string', enum: ['decision', 'feature', 'bug', 'content', 'todo', 'context'], description: 'Filter by category (optional)' },
        limit: { type: 'number', description: 'Max results to return (default 20)' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'create_skill',
    description: 'Create a new skill for agents. Skills are reusable instruction sets that can be attached to sessions to give agents specific capabilities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Skill name (e.g. "Code Review", "WordPress Development")' },
        prompt: { type: 'string', description: 'Skill instructions/prompt - what the agent should know or do when this skill is active' },
        description: { type: 'string', description: 'Short description of the skill (optional)' },
        icon: { type: 'string', description: 'Emoji icon for the skill (optional, defaults to lightning bolt)' },
        scope: { type: 'string', enum: ['global', 'project'], description: 'Scope: "global" (available to all projects) or "project" (specific projects only). Default: global' },
        project_ids: { type: 'string', description: 'JSON array of project IDs to assign the skill to (only used when scope is "project")' },
        globs: { type: 'string', description: 'JSON array of file glob patterns that auto-activate this skill (optional)' },
        source_url: { type: 'string', description: 'Source URL if the skill was imported from a remote source (optional)' },
      },
      required: ['name', 'prompt'],
    },
  },
  {
    name: 'delegate_task',
    description: 'Delegate work to another agent in any project. Creates a new session in the target project with the specified agent, sends the instruction, and the agent starts working asynchronously. Use get_project_status to check progress later.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Target project ID' },
        agent_name: { type: 'string', description: 'Name of the agent to delegate to (case-insensitive)' },
        title: { type: 'string', description: 'Session title describing the task' },
        instruction: { type: 'string', description: 'Detailed instruction for the agent' },
        mode: { type: 'string', enum: ['explore', 'ask', 'execute'], description: 'Permission mode (default: execute)' },
      },
      required: ['project_id', 'agent_name', 'title', 'instruction'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a follow-up message to an existing session. The agent will process it asynchronously.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'Session ID to send the message to' },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['session_id', 'content'],
    },
  },
  {
    name: 'read_project_file',
    description: 'Read a file from any project by project ID and relative path. Useful for cross-project reference without needing to know the project directory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        path: { type: 'string', description: 'Relative file path within the project' },
      },
      required: ['project_id', 'path'],
    },
  },
  {
    name: 'get_project_status',
    description: 'Get the current status of a project: recent sessions, what agents are working on, latest activity, and progress. Use this when someone asks how a project is doing or what progress has been made.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        project_id: { type: 'string', description: 'Project ID to check status for' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'create_mcp',
    description: 'Create a new MCP (Model Context Protocol) server. MCP servers provide tools and capabilities to agents. After creating, the user may need to add API keys in the env field via the UI.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (e.g. "Notion", "Slack", "GitHub")' },
        description: { type: 'string', description: 'Short description of what this MCP does' },
        command: { type: 'string', description: 'Command to run the MCP (e.g. "npx", "node", "python")' },
        args: { type: 'string', description: 'JSON array of command arguments (e.g. \'["-y", "notion-mcp"]\')' },
        env: { type: 'string', description: 'JSON object of environment variables. Use empty string for values that need user input (e.g. \'{"NOTION_API_KEY": ""}\')' },
        enabled: { type: 'boolean', description: 'Whether the MCP is enabled (default: true)' },
        is_default: { type: 'boolean', description: 'Whether to enable by default for new sessions (default: false)' },
        source_url: { type: 'string', description: 'Source URL (npm package, GitHub repo) for reference' },
      },
      required: ['name', 'command', 'args'],
    },
  },
  {
    name: 'use_skill',
    description: 'Load the full prompt for an enabled skill by name. Use this when a skill is relevant to the current task. Returns the complete skill instructions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Skill name (case-insensitive)' },
      },
      required: ['name'],
    },
  },
];

// ---- Handlers --------------------------------------------------------------

export function handleInitialize(id: number | string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'project-manager', version: '1.0.0' },
    },
  };
}

export function handleToolsList(id: number | string): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: { tools: TOOLS },
  };
}

export function handleToolCall(
  id: number | string,
  params: { name: string; arguments?: Record<string, unknown> },
  ctx: McpContext,
): JsonRpcResponse {
  const { name, arguments: args = {} } = params;
  const { db, userId: USER_ID, sessionId: SESSION_ID } = ctx;

  try {
    switch (name) {
      case 'create_project': {
        const projectName = args.name as string;
        if (!projectName) throw new Error('name is required');
        const description = (args.description as string) || '';

        const projectId = randomUUID();
        const slug = slugify(projectName);
        const projectPath = join(PROJECTS_ROOT, slug);
        if (!existsSync(projectPath)) mkdirSync(projectPath, { recursive: true });

        db.prepare('INSERT INTO projects (id, name, description, path, git_push_disabled, user_id) VALUES (?, ?, ?, ?, 1, ?)')
          .run(projectId, projectName, description, projectPath, USER_ID);

        return success(id, `Project created successfully.\n\nID: ${projectId}\nName: ${projectName}\nPath: ${projectPath}\n\nThe project folder has been created and registered in the system. It will appear in the sidebar after a page refresh.`);
      }

      case 'clone_project': {
        const projectName = args.name as string;
        const gitUrl = args.git_url as string;
        if (!projectName) throw new Error('name is required');
        if (!gitUrl) throw new Error('git_url is required');
        const description = (args.description as string) || '';

        const projectId = randomUUID();
        const slug = slugify(projectName);
        const projectPath = join(PROJECTS_ROOT, slug);
        if (!existsSync(projectPath)) mkdirSync(projectPath, { recursive: true });

        try {
          execSync(`git clone ${JSON.stringify(gitUrl)} .`, {
            cwd: projectPath,
            timeout: 120_000,
            stdio: 'pipe',
          });
        } catch (err: any) {
          try { execSync(`rm -rf ${JSON.stringify(projectPath)}`); } catch { /* ignore */ }
          throw new Error(`Git clone failed: ${err.stderr?.toString() || err.message}`);
        }

        db.prepare('INSERT INTO projects (id, name, description, path, git_push_disabled, git_origin_url, user_id) VALUES (?, ?, ?, ?, 1, ?, ?)')
          .run(projectId, projectName, description, projectPath, gitUrl, USER_ID);

        return success(id, `Project created and repository cloned successfully.\n\nID: ${projectId}\nName: ${projectName}\nPath: ${projectPath}\nCloned from: ${gitUrl}\n\nThe project will appear in the sidebar after a page refresh.`);
      }

      case 'list_projects': {
        let listSql = "SELECT id, name, description, path FROM projects WHERE is_general = 0";
        const listParams: unknown[] = [];
        if (USER_ID) {
          listSql += " AND user_id = ?";
          listParams.push(USER_ID);
        }
        listSql += " ORDER BY name ASC";
        const rows = db.prepare(listSql).all(...listParams) as {
          id: string; name: string; description: string; path: string | null;
        }[];

        if (rows.length === 0) {
          return success(id, 'No projects found.');
        }

        const list = rows.map(r => `- ${r.name} (ID: ${r.id})${r.path ? `\n  Path: ${r.path}` : ''}`).join('\n');
        return success(id, `Found ${rows.length} project(s):\n\n${list}`);
      }

      case 'get_project_memory': {
        const rawProjectId = args.project_id as string;
        if (!rawProjectId) throw new Error('project_id is required');
        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);

        const row = db.prepare('SELECT summary FROM project_memory WHERE project_id = ?').get(projectId) as { summary: string | null } | undefined;
        if (!row || !row.summary) {
          return success(id, 'No project memory set for this project.');
        }
        return success(id, row.summary);
      }

      case 'update_project_memory': {
        const rawProjectId = args.project_id as string;
        const summary = args.summary as string;
        if (!rawProjectId) throw new Error('project_id is required');
        if (!summary) throw new Error('summary is required');
        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);

        const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
        if (!project) throw new Error(`Project not found: ${projectId}`);

        const existing = db.prepare('SELECT id FROM project_memory WHERE project_id = ?').get(projectId);
        if (existing) {
          db.prepare("UPDATE project_memory SET summary = ?, updated_at = datetime('now') WHERE project_id = ?").run(summary, projectId);
        } else {
          const memId = randomUUID();
          db.prepare('INSERT INTO project_memory (id, project_id, summary) VALUES (?, ?, ?)').run(memId, projectId, summary);
        }

        return success(id, 'Project memory updated successfully.');
      }

      case 'get_server_config': {
        const rawProjectId = args.project_id as string;
        if (!rawProjectId) throw new Error('project_id is required');
        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);

        const row = db.prepare('SELECT server_config FROM projects WHERE id = ?').get(projectId) as { server_config: string | null } | undefined;
        if (!row) throw new Error(`Project not found: ${projectId}`);
        if (!row.server_config) {
          return success(id, 'No server config set for this project.');
        }
        return success(id, row.server_config);
      }

      case 'update_server_config': {
        const rawProjectId = args.project_id as string;
        const serverConfig = args.server_config as string;
        if (!rawProjectId) throw new Error('project_id is required');
        if (!serverConfig) throw new Error('server_config is required');
        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);

        const proj = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
        if (!proj) throw new Error(`Project not found: ${projectId}`);

        db.prepare("UPDATE projects SET server_config = ?, updated_at = datetime('now') WHERE id = ?").run(serverConfig, projectId);
        return success(id, 'Server config updated successfully.');
      }

      case 'add_memory_entry': {
        const rawProjectId = args.project_id as string;
        const category = args.category as string;
        const title = args.title as string;
        const content = args.content as string;
        const tags = (args.tags as string) || '[]';
        if (!rawProjectId) throw new Error('project_id is required');
        if (!category) throw new Error('category is required');
        if (!title) throw new Error('title is required');
        if (!content) throw new Error('content is required');
        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);

        const validCategories = ['decision', 'feature', 'bug', 'content', 'todo', 'context'];
        if (!validCategories.includes(category)) throw new Error(`Invalid category: ${category}. Must be one of: ${validCategories.join(', ')}`);

        const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
        if (!project) throw new Error(`Project not found: ${projectId}`);

        const entryId = randomUUID();
        db.prepare('INSERT INTO memory_entries (id, project_id, category, title, content, tags) VALUES (?, ?, ?, ?, ?, ?)')
          .run(entryId, projectId, category, title, content, tags);

        return success(id, `Memory entry created.\n\nID: ${entryId}\nCategory: ${category}\nTitle: ${title}`);
      }

      case 'search_memory': {
        const query = args.query as string;
        const rawProjectId = args.project_id as string | undefined;
        const category = args.category as string | undefined;
        const limit = (args.limit as number) || 20;
        if (!query) throw new Error('query is required');

        const projectId = rawProjectId ? resolveProjectId(db, rawProjectId, USER_ID) : undefined;

        let sql = `
          SELECT me.id, me.category, me.title, me.content, me.tags, me.created_at, p.name as project_name
          FROM memory_entries_fts fts
          JOIN memory_entries me ON me.rowid = fts.rowid
          JOIN projects p ON me.project_id = p.id
          WHERE memory_entries_fts MATCH ?
        `;
        const sqlParams: unknown[] = [query];

        if (USER_ID) {
          sql += ' AND p.user_id = ?';
          sqlParams.push(USER_ID);
        }

        if (projectId) {
          sql += ' AND me.project_id = ?';
          sqlParams.push(projectId);
        }
        if (category) {
          sql += ' AND me.category = ?';
          sqlParams.push(category);
        }
        sql += ' ORDER BY rank LIMIT ?';
        sqlParams.push(limit);

        const rows = db.prepare(sql).all(...sqlParams) as {
          id: string; category: string; title: string; content: string; tags: string; created_at: string; project_name: string;
        }[];

        if (rows.length === 0) {
          return success(id, `No memory entries found for query: "${query}"`);
        }

        const results = rows.map(r =>
          `[${r.category}] ${r.title} (${r.project_name}, ${r.created_at})\n${r.content.substring(0, 300)}${r.content.length > 300 ? '...' : ''}\nTags: ${r.tags}`
        ).join('\n\n---\n\n');
        return success(id, `Found ${rows.length} result(s):\n\n${results}`);
      }

      case 'list_memory_entries': {
        const rawProjectId = args.project_id as string;
        const category = args.category as string | undefined;
        const limit = (args.limit as number) || 20;
        if (!rawProjectId) throw new Error('project_id is required');
        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);

        let sql = 'SELECT id, category, title, content, tags, created_at FROM memory_entries WHERE project_id = ?';
        const sqlParams: unknown[] = [projectId];

        if (category) {
          sql += ' AND category = ?';
          sqlParams.push(category);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        sqlParams.push(limit);

        const rows = db.prepare(sql).all(...sqlParams) as {
          id: string; category: string; title: string; content: string; tags: string; created_at: string;
        }[];

        if (rows.length === 0) {
          return success(id, 'No memory entries found for this project.');
        }

        const results = rows.map(r =>
          `[${r.category}] ${r.title} (${r.created_at})\n${r.content.substring(0, 200)}${r.content.length > 200 ? '...' : ''}`
        ).join('\n\n');
        return success(id, `Found ${rows.length} entry/entries:\n\n${results}`);
      }

      case 'create_skill': {
        const skillName = args.name as string;
        const prompt = args.prompt as string;
        if (!skillName) throw new Error('name is required');
        if (!prompt) throw new Error('prompt is required');

        const description = (args.description as string) || '';
        const icon = (args.icon as string) || '';
        const scope = (args.scope as string) || 'global';
        const projectIds = args.project_ids ? JSON.parse(args.project_ids as string) as string[] : [];
        const globs = (args.globs as string) || null;
        const sourceUrl = (args.source_url as string) || null;

        const skillId = randomUUID();
        const slug = slugify(skillName);
        const isGlobal = scope === 'global' ? 1 : 0;

        db.prepare(`INSERT INTO skills (id, name, slug, description, prompt, is_global, scope, icon, globs, source_url, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(skillId, skillName, slug, description, prompt, isGlobal, scope, icon || '', globs, sourceUrl, USER_ID);

        if (scope === 'project' && projectIds.length > 0) {
          const insertSkillProject = db.prepare('INSERT INTO skill_projects (skill_id, project_id) VALUES (?, ?)');
          for (const pid of projectIds) {
            insertSkillProject.run(skillId, pid);
          }
        }

        return success(id, `Skill created successfully.\n\nID: ${skillId}\nName: ${skillName}\nScope: ${scope}${sourceUrl ? `\nSource: ${sourceUrl}` : ''}`);
      }

      case 'create_mcp': {
        const mcpName = args.name as string;
        const command = args.command as string;
        const argsJson = args.args as string;
        if (!mcpName) throw new Error('name is required');
        if (!command) throw new Error('command is required');
        if (!argsJson) throw new Error('args is required (JSON array)');

        let parsedArgs: string[];
        try {
          parsedArgs = JSON.parse(argsJson);
          if (!Array.isArray(parsedArgs)) throw new Error('args must be a JSON array');
        } catch (e: any) {
          throw new Error(`Invalid args JSON: ${e.message}`);
        }

        const description = (args.description as string) || '';
        const envJson = (args.env as string) || '{}';
        const enabled = args.enabled !== false ? 1 : 0;
        const isDefault = args.is_default === true ? 1 : 0;
        const sourceUrl = (args.source_url as string) || null;

        try {
          JSON.parse(envJson);
        } catch (e: any) {
          throw new Error(`Invalid env JSON: ${e.message}`);
        }

        const mcpId = randomUUID();

        db.prepare(`INSERT INTO mcp_servers (id, name, description, command, args, env, enabled, is_default, is_internal, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
          .run(mcpId, mcpName, description, command, argsJson, envJson, enabled, isDefault, USER_ID);

        const env = JSON.parse(envJson);
        const emptyKeys = Object.entries(env).filter(([_, v]) => v === '').map(([k]) => k);
        const needsConfig = emptyKeys.length > 0;

        let message = `MCP server created successfully.\n\nID: ${mcpId}\nName: ${mcpName}\nCommand: ${command} ${parsedArgs.join(' ')}`;
        if (sourceUrl) message += `\nSource: ${sourceUrl}`;
        if (needsConfig) {
          message += `\n\nNOTE: The following environment variables need to be configured in the MCP settings:\n- ${emptyKeys.join('\n- ')}`;
        }

        return success(id, message);
      }

      case 'get_project_status': {
        const rawProjectId = args.project_id as string;
        if (!rawProjectId) throw new Error('project_id is required');
        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);

        const project = db.prepare('SELECT id, name, description, path FROM projects WHERE id = ?').get(projectId) as {
          id: string; name: string; description: string; path: string | null;
        } | undefined;
        if (!project) throw new Error(`Project not found: ${projectId}`);

        const sessions = db.prepare(`
          SELECT s.id, s.title, s.status, s.status_updated_at, s.updated_at, a.name as agent_name
          FROM sessions s JOIN agents a ON s.agent_id = a.id
          WHERE s.project_id = ?
          ORDER BY s.updated_at DESC LIMIT 10
        `).all(projectId) as {
          id: string; title: string; status: string; status_updated_at: string; updated_at: string; agent_name: string;
        }[];

        const activity = db.prepare(`
          SELECT al.action, al.actor, al.from_status, al.to_status, al.created_at, s.title as session_title
          FROM activity_log al JOIN sessions s ON al.session_id = s.id
          WHERE s.project_id = ?
          ORDER BY al.created_at DESC LIMIT 10
        `).all(projectId) as {
          action: string; actor: string; from_status: string | null; to_status: string | null; created_at: string; session_title: string;
        }[];

        const recentMessages = db.prepare(`
          SELECT m.role, m.content, m.created_at, s.title as session_title, a.name as agent_name
          FROM messages m
          JOIN sessions s ON m.session_id = s.id
          JOIN agents a ON s.agent_id = a.id
          WHERE s.project_id = ?
          ORDER BY m.created_at DESC LIMIT 10
        `).all(projectId) as {
          role: string; content: string; created_at: string; session_title: string; agent_name: string;
        }[];

        const memory = db.prepare('SELECT summary FROM project_memory WHERE project_id = ?').get(projectId) as { summary: string } | undefined;

        const memEntries = db.prepare('SELECT category, title, created_at FROM memory_entries WHERE project_id = ? ORDER BY created_at DESC LIMIT 5')
          .all(projectId) as { category: string; title: string; created_at: string }[];

        const parts: string[] = [];
        parts.push(`Project: ${project.name}${project.description ? ` - ${project.description}` : ''}`);

        if (sessions.length > 0) {
          const sessionLines = sessions.map(s =>
            `  [${s.status}] "${s.title}" (${s.agent_name}, last active ${s.updated_at})`
          ).join('\n');
          parts.push(`\nSessions (${sessions.length}):\n${sessionLines}`);
        } else {
          parts.push('\nNo sessions yet.');
        }

        if (activity.length > 0) {
          const activityLines = activity.map(a => {
            const statusChange = a.from_status && a.to_status ? ` (${a.from_status} -> ${a.to_status})` : '';
            return `  ${a.created_at} - ${a.actor}: ${a.action}${statusChange} in "${a.session_title}"`;
          }).join('\n');
          parts.push(`\nRecent activity:\n${activityLines}`);
        }

        if (recentMessages.length > 0) {
          const msgLines = recentMessages.map(m =>
            `  [${m.agent_name}/${m.session_title}] ${m.role} (${m.created_at}): ${m.content.substring(0, 150)}${m.content.length > 150 ? '...' : ''}`
          ).join('\n');
          parts.push(`\nLatest messages:\n${msgLines}`);
        }

        if (memory?.summary) {
          parts.push(`\nProject memory:\n${memory.summary.substring(0, 500)}${memory.summary.length > 500 ? '...' : ''}`);
        }

        if (memEntries.length > 0) {
          const entryLines = memEntries.map(e => `  [${e.category}] ${e.title} (${e.created_at})`).join('\n');
          parts.push(`\nRecent memory entries:\n${entryLines}`);
        }

        return success(id, parts.join('\n'));
      }

      case 'delegate_task': {
        const rawProjectId = args.project_id as string;
        const agentName = args.agent_name as string;
        const title = args.title as string;
        const instruction = args.instruction as string;
        const mode = (args.mode as string) || 'execute';
        if (!rawProjectId) throw new Error('project_id is required');
        if (!agentName) throw new Error('agent_name is required');
        if (!title) throw new Error('title is required');
        if (!instruction) throw new Error('instruction is required');

        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);
        const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
        if (!project) throw new Error(`Project not found: ${projectId}`);

        let agentSql = 'SELECT id, name FROM agents WHERE LOWER(name) = LOWER(?)';
        const agentParams: unknown[] = [agentName];
        if (USER_ID) {
          agentSql += ' AND user_id = ?';
          agentParams.push(USER_ID);
        }
        const agent = db.prepare(agentSql).get(...agentParams) as { id: string; name: string } | undefined;
        if (!agent) throw new Error(`Agent not found: ${agentName}`);

        const sessionId = randomUUID();
        db.prepare('INSERT INTO sessions (id, project_id, agent_id, title, status, mode, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(sessionId, projectId, agent.id, title, 'in_progress', mode, USER_ID);

        db.prepare('INSERT INTO memory (id, session_id) VALUES (?, ?)').run(randomUUID(), sessionId);

        const skillSql = USER_ID
          ? 'SELECT id FROM skills WHERE is_global = 1 AND user_id = ?'
          : 'SELECT id FROM skills WHERE is_global = 1';
        const globalSkills = (USER_ID ? db.prepare(skillSql).all(USER_ID) : db.prepare(skillSql).all()) as { id: string }[];
        const insertSkill = db.prepare('INSERT INTO session_skills (session_id, skill_id, enabled) VALUES (?, ?, 1)');
        for (const skill of globalSkills) {
          insertSkill.run(sessionId, skill.id);
        }

        const apiSql = USER_ID
          ? 'SELECT id FROM apis WHERE user_id = ?'
          : 'SELECT id FROM apis';
        const allApis = (USER_ID ? db.prepare(apiSql).all(USER_ID) : db.prepare(apiSql).all()) as { id: string }[];
        const insertApi = db.prepare('INSERT OR IGNORE INTO session_apis (session_id, api_id, enabled) VALUES (?, ?, 1)');
        for (const api of allApis) {
          insertApi.run(sessionId, api.id);
        }

        db.prepare('INSERT INTO activity_log (id, session_id, action, actor, from_status, to_status) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), sessionId, 'delegated', 'ai', null, 'in_progress');

        const postData = JSON.stringify({ sessionId, content: instruction, mode });
        const req = http.request({
          hostname: '127.0.0.1',
          port: 3001,
          path: '/api/internal/trigger-message',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        }, () => { /* ignore response */ });
        req.on('error', (err) => { console.error('[MCP] trigger-message error:', err.message); });
        req.write(postData);
        req.end();

        return success(id, `Task delegated successfully.\n\nSession ID: ${sessionId}\nProject: ${project.name}\nAgent: ${agent.name}\nTitle: ${title}\nMode: ${mode}\n\nThe agent is now working asynchronously. Use get_project_status to check progress, or send_message to send follow-up instructions.`);
      }

      case 'send_message': {
        const sessionId = args.session_id as string;
        const content = args.content as string;
        if (!sessionId) throw new Error('session_id is required');
        if (!content) throw new Error('content is required');

        let sessSql = 'SELECT id FROM sessions WHERE id = ?';
        const sessParams: unknown[] = [sessionId];
        if (USER_ID) {
          sessSql += ' AND user_id = ?';
          sessParams.push(USER_ID);
        }
        const sess = db.prepare(sessSql).get(...sessParams) as { id: string } | undefined;
        if (!sess) throw new Error(`Session not found: ${sessionId}`);

        const postData = JSON.stringify({ sessionId, content });
        const req = http.request({
          hostname: '127.0.0.1',
          port: 3001,
          path: '/api/internal/trigger-message',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        }, () => { /* ignore response */ });
        req.on('error', (err) => { console.error('[MCP] trigger-message error:', err.message); });
        req.write(postData);
        req.end();

        return success(id, `Message sent to session ${sessionId}. The agent will process it asynchronously.`);
      }

      case 'read_project_file': {
        const rawProjectId = args.project_id as string;
        const filePath = args.path as string;
        if (!rawProjectId) throw new Error('project_id is required');
        if (!filePath) throw new Error('path is required');
        const projectId = resolveProjectId(db, rawProjectId, USER_ID);
        verifyProjectAccess(db, USER_ID, projectId);

        const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(projectId) as { path: string | null } | undefined;
        if (!project) throw new Error(`Project not found: ${projectId}`);
        if (!project.path) throw new Error('Project has no path set');

        const resolved = resolve(project.path, filePath);
        if (!resolved.startsWith(project.path)) {
          throw new Error('Path traversal not allowed');
        }

        const stat = statSync(resolved, { throwIfNoEntry: false });
        if (!stat || !stat.isFile()) throw new Error(`File not found: ${filePath}`);
        if (stat.size > 100 * 1024) throw new Error('File too large (max 100KB)');

        const fileContent = readFileSync(resolved, 'utf-8');
        return success(id, fileContent);
      }

      case 'use_skill': {
        const skillName = args.name as string;
        if (!skillName) throw new Error('name is required');
        if (!SESSION_ID) throw new Error('SESSION_ID not available in environment');

        const skill = db.prepare(`
          SELECT sk.name, sk.prompt FROM skills sk
          JOIN session_skills ss ON ss.skill_id = sk.id
          WHERE LOWER(sk.name) = LOWER(?) AND ss.session_id = ? AND ss.enabled = 1
        `).get(skillName, SESSION_ID) as { name: string; prompt: string } | undefined;

        if (!skill) {
          throw new Error(`Skill not found or not enabled for this session: ${skillName}`);
        }

        return success(id, `# Skill: ${skill.name}\n\n${skill.prompt}`);
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        };
    }
  } catch (err: any) {
    return success(id, `Error: ${err.message}`, true);
  }
}
