import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import { removeWorktree } from '../claude/worktree.js';
import { despawnAgentContainer } from '../claude/docker-spawn.js';

const router = Router();

function logActivity(sessionId: string, action: string, actor: 'user' | 'ai', fromStatus?: string | null, toStatus?: string | null) {
  getDb().prepare(
    'INSERT INTO activity_log (id, session_id, action, actor, from_status, to_status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(uuid(), sessionId, action, actor, fromStatus ?? null, toStatus ?? null);
}

router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { project_id } = req.query;
  let rows;
  if (project_id) {
    rows = getDb()
      .prepare('SELECT * FROM sessions WHERE project_id = ? AND user_id = ? ORDER BY updated_at DESC')
      .all(project_id, userId);
  } else {
    rows = getDb()
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC')
      .all(userId);
  }
  res.json(rows);
});

router.get('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { project_id, agent_id, title = 'New Session' } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });

  // Use user's general project if no project_id provided
  const db = getDb();
  const pid = project_id || (db.prepare("SELECT id FROM projects WHERE user_id = ? AND is_general = 1").get(userId) as { id: string } | undefined)?.id;
  if (!pid) return res.status(400).json({ error: 'No project found' });

  const id = uuid();
  db.prepare('INSERT INTO sessions (id, project_id, agent_id, title, status, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, pid, agent_id, title, 'backlog', userId);
  db.prepare('INSERT INTO memory (id, session_id) VALUES (?, ?)').run(uuid(), id);

  // Enable all global skills for this user
  const globalSkills = db.prepare("SELECT id FROM skills WHERE is_global = 1 AND user_id = ?").all(userId) as { id: string }[];
  const insertSkill = db.prepare('INSERT INTO session_skills (session_id, skill_id, enabled) VALUES (?, ?, 1)');
  for (const skill of globalSkills) {
    insertSkill.run(id, skill.id);
  }

  logActivity(id, 'created', 'user', null, 'backlog');
  res.status(201).json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
});

router.put('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { title, agent_id, mode } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE sessions SET title = COALESCE(?, title), agent_id = COALESCE(?, agent_id), mode = COALESCE(?, mode), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(title ?? null, agent_id ?? null, mode ?? null, req.params.id, userId);
  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id));
});

router.patch('/:id/status', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { status, actor = 'user' } = req.body;
  const validStatuses = ['backlog', 'in_progress', 'review', 'done'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const db = getDb();
  const existing = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, userId) as any;
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const fromStatus = existing.status;
  db.prepare("UPDATE sessions SET status = ?, status_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(status, req.params.id, userId);
  logActivity(req.params.id, `moved`, actor, fromStatus, status);

  // Despawn agent container when session moves to 'done'
  if (status === 'done') {
    despawnAgentContainer(req.params.id).catch(() => {});
  }

  // Clean up worktree when session moves to 'done'
  if (status === 'done' && existing.worktree_path) {
    const projRow = db.prepare('SELECT path FROM projects WHERE id = ?').get(existing.project_id) as { path: string | null } | undefined;
    if (projRow?.path) {
      try {
        removeWorktree(req.params.id, projRow.path);
        db.prepare("UPDATE sessions SET worktree_path = NULL WHERE id = ?").run(req.params.id);
      } catch (err: any) {
        console.error(`[SESSION] Worktree cleanup on done failed: ${err.message}`);
      }
    }
  }

  res.json(db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const db = getDb();

  // Clean up worktree before deleting session
  const session = db.prepare(`
    SELECT s.worktree_path, p.path as project_path
    FROM sessions s JOIN projects p ON s.project_id = p.id
    WHERE s.id = ? AND s.user_id = ?
  `).get(req.params.id, userId) as { worktree_path: string | null; project_path: string | null } | undefined;

  // Despawn agent container
  despawnAgentContainer(req.params.id).catch(() => {});

  if (session?.worktree_path && session.project_path) {
    try {
      removeWorktree(req.params.id, session.project_path);
    } catch (err: any) {
      console.error(`[SESSION] Worktree cleanup failed: ${err.message}`);
    }
  }

  db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.id, userId);
  res.status(204).end();
});

router.get('/:id/messages', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const db = getDb();
  // Verify session ownership
  const session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json(rows);
});

export { logActivity };
export default router;
