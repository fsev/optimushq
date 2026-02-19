import { Router, Request, Response } from 'express';
import { execSync } from 'child_process';
import { getDb } from '../db/connection.js';

const router = Router();
const EXEC_TIMEOUT = 15_000;

interface ProjectRow {
  path: string | null;
  git_push_disabled: number;
  git_protected_branches: string;
}

function getProject(projectId: string, userId?: string): ProjectRow | null {
  let row: ProjectRow | undefined;
  if (userId) {
    row = getDb().prepare('SELECT path, git_push_disabled, git_protected_branches FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId) as ProjectRow | undefined;
  } else {
    row = getDb().prepare('SELECT path, git_push_disabled, git_protected_branches FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  }
  return row ?? null;
}

/**
 * Get the working directory for git operations.
 * If a session_id is provided and the session has a worktree, use that instead.
 */
function getWorkingDir(projectId: string, sessionId?: string, userId?: string): string | null {
  const project = getProject(projectId, userId);
  if (!project?.path) return null;

  if (sessionId) {
    const db = getDb();
    const session = db.prepare('SELECT worktree_path FROM sessions WHERE id = ?').get(sessionId) as { worktree_path: string | null } | undefined;
    if (session?.worktree_path) {
      return session.worktree_path;
    }
  }

  return project.path;
}

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, timeout: EXEC_TIMEOUT, encoding: 'utf-8' }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, timeout: EXEC_TIMEOUT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// GET /status/:projectId
router.get('/status/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found or has no path' });

  if (!isGitRepo(cwd)) {
    return res.json({ isGitRepo: false });
  }

  try {
    let branch = 'main';
    try {
      branch = git('rev-parse --abbrev-ref HEAD', cwd);
    } catch {
      // Fresh repo with no commits — fall back to default branch name
      try {
        const symbolic = git('symbolic-ref --short HEAD', cwd);
        if (symbolic) branch = symbolic;
      } catch { /* stick with 'main' */ }
    }

    let ahead = 0;
    let behind = 0;
    try {
      const counts = git('rev-list --left-right --count HEAD...@{upstream}', cwd);
      const parts = counts.split(/\s+/);
      ahead = parseInt(parts[0]) || 0;
      behind = parseInt(parts[1]) || 0;
    } catch {
      // No upstream configured or no commits yet
    }

    const statusOutput = git('status --porcelain', cwd);
    const files = statusOutput
      ? statusOutput.split('\n').map(line => {
          const indexStatus = line[0];
          const workTreeStatus = line[1];
          const filePath = line.substring(3);

          // A file can appear in both staged and unstaged
          const entries: { path: string; status: string; staged: boolean }[] = [];

          if (indexStatus !== ' ' && indexStatus !== '?') {
            entries.push({ path: filePath, status: indexStatus, staged: true });
          }
          if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
            entries.push({ path: filePath, status: workTreeStatus, staged: false });
          }
          if (indexStatus === '?' && workTreeStatus === '?') {
            entries.push({ path: filePath, status: '??', staged: false });
          }

          return entries;
        }).flat()
      : [];

    res.json({ isGitRepo: true, branch, ahead, behind, files });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /diff/:projectId
router.get('/diff/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found' });

  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'path query param required' });

  const staged = req.query.staged === 'true';

  try {
    let diff: string;
    if (staged) {
      diff = git(`diff --cached -- ${JSON.stringify(filePath)}`, cwd);
    } else {
      // For untracked files, show the full content as a diff
      try {
        git(`ls-files --error-unmatch -- ${JSON.stringify(filePath)}`, cwd);
        diff = git(`diff -- ${JSON.stringify(filePath)}`, cwd);
      } catch {
        // Untracked file — show full content with + prefix
        try {
          const content = git(`show :${filePath}`, cwd);
          diff = content;
        } catch {
          diff = execSync(`cat ${JSON.stringify(filePath)}`, {
            cwd,
            timeout: EXEC_TIMEOUT,
            encoding: 'utf-8',
          });
          diff = diff.split('\n').map(l => `+${l}`).join('\n');
        }
      }
    }
    res.json({ path: filePath, diff });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /branches/:projectId
router.get('/branches/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found' });

  try {
    const output = git('branch -a', cwd);
    const branches = output.split('\n').filter(Boolean).map(line => {
      const current = line.startsWith('*');
      const name = line.replace(/^\*?\s+/, '').replace(/^remotes\//, '');
      const remote = line.includes('remotes/');
      return { name, current, remote };
    });
    res.json(branches);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /log/:projectId
router.get('/log/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found' });

  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

  try {
    const output = git(`log --format=%H%n%h%n%s%n%an%n%ai -n ${limit}`, cwd);
    if (!output) return res.json([]);

    const lines = output.split('\n');
    const entries = [];
    for (let i = 0; i + 4 < lines.length; i += 5) {
      entries.push({
        hash: lines[i],
        shortHash: lines[i + 1],
        message: lines[i + 2],
        author: lines[i + 3],
        date: lines[i + 4],
      });
    }
    res.json(entries);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /stage/:projectId
router.post('/stage/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found' });

  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'paths array required' });

  try {
    const escaped = paths.map(p => JSON.stringify(p)).join(' ');
    git(`add -- ${escaped}`, cwd);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /unstage/:projectId
router.post('/unstage/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found' });

  const { paths } = req.body;
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'paths array required' });

  try {
    const escaped = paths.map(p => JSON.stringify(p)).join(' ');
    git(`reset HEAD -- ${escaped}`, cwd);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /commit/:projectId
router.post('/commit/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found' });

  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message string required' });

  try {
    git(`commit -m ${JSON.stringify(message)}`, cwd);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /checkout/:projectId
router.post('/checkout/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found' });

  const { branch } = req.body;
  if (!branch || typeof branch !== 'string') return res.status(400).json({ error: 'branch string required' });

  try {
    git(`checkout ${JSON.stringify(branch)}`, cwd);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /pull/:projectId
router.post('/pull/:projectId', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id);
  if (!cwd) return res.status(404).json({ error: 'Project not found' });

  try {
    const output = git('pull', cwd);
    res.json({ ok: true, output });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /push/:projectId
router.post('/push/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found' });
  const sessionId = req.query.session_id as string | undefined;
  const cwd = getWorkingDir(req.params.projectId, sessionId, req.user!.id) || project.path;

  // Enforce git_push_disabled
  if (project.git_push_disabled) {
    return res.status(403).json({ error: 'Push is disabled for this project (pull-only mode)' });
  }

  // Enforce protected branches
  if (project.git_protected_branches) {
    try {
      const currentBranch = git('rev-parse --abbrev-ref HEAD', cwd);
      const protectedList = project.git_protected_branches.split(',').map(b => b.trim()).filter(Boolean);
      if (protectedList.includes(currentBranch)) {
        return res.status(403).json({ error: `Push to protected branch "${currentBranch}" is not allowed` });
      }
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const output = git('push', cwd);
    res.json({ ok: true, output });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /init/:projectId
router.post('/init/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found or has no path' });

  if (isGitRepo(project.path)) {
    return res.status(400).json({ error: 'Already a git repository' });
  }

  try {
    git('init', project.path);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /clone/:projectId
router.post('/clone/:projectId', (req: Request, res: Response) => {
  const project = getProject(req.params.projectId, req.user!.id);
  if (!project?.path) return res.status(404).json({ error: 'Project not found or has no path' });

  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url string required' });

  try {
    // Clone into the project directory (which already exists), so use "." as target
    execSync(`git clone ${JSON.stringify(url)} .`, {
      cwd: project.path,
      timeout: 60_000, // clones can be slow
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    // Auto-set git_origin_url from the clone URL
    getDb().prepare("UPDATE projects SET git_origin_url = ?, updated_at = datetime('now') WHERE id = ?")
      .run(url, req.params.projectId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.stderr || err.message });
  }
});

export default router;
