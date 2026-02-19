import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import Docker from 'dockerode';

const router = Router();

// GET /images — list available agent Docker images
// This route MUST be before /:id to avoid matching 'images' as an id
router.get('/images', async (_req: Request, res: Response) => {
  try {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    const images = await docker.listImages();
    const agentImages: { name: string; fullTag: string }[] = [];

    for (const img of images) {
      const tags = img.RepoTags || [];
      for (const tag of tags) {
        if (tag.startsWith('claude-agent-')) {
          const name = tag.split(':')[0];
          agentImages.push({ name, fullTag: tag });
        }
      }
    }

    res.json(agentImages);
  } catch (err: any) {
    // Docker not available — return empty list
    res.json([]);
  }
});

router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const rows = getDb().prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY is_default DESC, name ASC').all(userId);
  res.json(rows);
});

router.get('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const row = getDb().prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { name, system_prompt, icon = '🤖', model = 'sonnet', docker_image = '' } = req.body;
  if (!name || !system_prompt) return res.status(400).json({ error: 'name and system_prompt required' });
  const id = uuid();
  getDb().prepare('INSERT INTO agents (id, name, system_prompt, icon, model, docker_image, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, system_prompt, icon, model, docker_image, userId);
  res.status(201).json(getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id));
});

router.put('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { name, system_prompt, icon, model, docker_image } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE agents SET name = COALESCE(?, name), system_prompt = COALESCE(?, system_prompt), icon = COALESCE(?, icon), model = COALESCE(?, model), docker_image = COALESCE(?, docker_image), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .run(name ?? null, system_prompt ?? null, icon ?? null, model ?? null, docker_image ?? null, req.params.id, userId);
  res.json(db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id));
});

router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.id;
  getDb().prepare('DELETE FROM agents WHERE id = ? AND user_id = ?').run(req.params.id, userId);
  res.status(204).end();
});

export default router;
