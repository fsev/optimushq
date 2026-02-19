import { execSync } from 'child_process';
import { existsSync, readFileSync, appendFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/connection.js';

const EXEC_TIMEOUT = 15_000;
const WORKTREES_DIR = '.worktrees';

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, timeout: EXEC_TIMEOUT, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, timeout: EXEC_TIMEOUT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine if a session needs its own worktree.
 * Returns false for explore mode, non-git repos, or when only one active write session exists.
 */
export function needsWorktree(sessionId: string, projectPath: string, mode?: string): boolean {
  // Explore mode sessions share the main checkout (read-only)
  if (mode === 'explore') return false;

  // Not a git repo — no worktrees possible
  if (!isGitRepo(projectPath)) return false;

  // Check if another active write session exists on the same project
  const db = getDb();
  const project = db.prepare(`
    SELECT p.id FROM sessions s
    JOIN projects p ON s.project_id = p.id
    WHERE s.id = ?
  `).get(sessionId) as { id: string } | undefined;
  if (!project) return false;

  const activeSessions = db.prepare(`
    SELECT s.id FROM sessions s
    WHERE s.project_id = ?
      AND s.id != ?
      AND s.status IN ('in_progress', 'backlog')
      AND s.mode != 'explore'
      AND s.worktree_path IS NULL
  `).all(project.id, sessionId) as { id: string }[];

  // Need a worktree if there's already an active write session on the main checkout
  return activeSessions.length > 0;
}

/**
 * Create a git worktree for a session.
 * Returns the path to the worktree directory.
 */
export function createWorktree(sessionId: string, projectPath: string): string {
  const shortId = sessionId.substring(0, 8);
  const worktreePath = join(projectPath, WORKTREES_DIR, sessionId);
  const branchName = `session/${shortId}`;

  // Create worktree with a new branch based on HEAD
  git(`worktree add -b "${branchName}" "${worktreePath}"`, projectPath);

  // Ensure .worktrees is in .gitignore
  ensureGitignore(projectPath);

  return worktreePath;
}

/**
 * Remove a worktree and its branch.
 */
export function removeWorktree(sessionId: string, projectPath: string): void {
  const shortId = sessionId.substring(0, 8);
  const worktreePath = join(projectPath, WORKTREES_DIR, sessionId);
  const branchName = `session/${shortId}`;

  try {
    // Remove the worktree
    if (existsSync(worktreePath)) {
      git(`worktree remove --force "${worktreePath}"`, projectPath);
    }
  } catch (err: any) {
    console.error(`[WORKTREE] Failed to remove worktree: ${err.message}`);
    // Try force cleanup
    try {
      git('worktree prune', projectPath);
    } catch {
      // ignore
    }
  }

  // Delete the branch
  try {
    git(`branch -D "${branchName}"`, projectPath);
  } catch {
    // Branch may not exist
  }
}

/**
 * Get the effective working path for a session.
 * Returns the worktree path if it exists, otherwise the project path.
 */
export function getSessionWorkPath(sessionId: string, projectPath: string): string {
  const db = getDb();
  const session = db.prepare('SELECT worktree_path FROM sessions WHERE id = ?').get(sessionId) as { worktree_path: string | null } | undefined;

  if (session?.worktree_path && existsSync(session.worktree_path)) {
    return session.worktree_path;
  }

  return projectPath;
}

/**
 * Clean up stale worktrees for sessions that no longer exist or are done.
 */
export function cleanupStaleWorktrees(projectPath: string): void {
  if (!isGitRepo(projectPath)) return;

  const worktreesDir = join(projectPath, WORKTREES_DIR);
  if (!existsSync(worktreesDir)) return;

  const db = getDb();

  try {
    // List all worktree directories
    const entries = readdirSync(worktreesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionId = entry.name;

      // Check if session still exists and is active
      const session = db.prepare(
        "SELECT status FROM sessions WHERE id = ?"
      ).get(sessionId) as { status: string } | undefined;

      if (!session || session.status === 'done') {
        removeWorktree(sessionId, projectPath);
      }
    }

    // Prune stale worktree references
    git('worktree prune', projectPath);
  } catch (err: any) {
    console.error(`[WORKTREE] Cleanup error: ${err.message}`);
  }
}

/**
 * Append .worktrees to the project's .gitignore if not already present.
 */
function ensureGitignore(projectPath: string): void {
  const gitignorePath = join(projectPath, '.gitignore');

  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (content.includes('.worktrees')) return;
      appendFileSync(gitignorePath, '\n# OptimusHQ session worktrees\n.worktrees\n');
    } else {
      appendFileSync(gitignorePath, '# OptimusHQ session worktrees\n.worktrees\n');
    }
  } catch (err: any) {
    console.error(`[WORKTREE] Failed to update .gitignore: ${err.message}`);
  }
}
