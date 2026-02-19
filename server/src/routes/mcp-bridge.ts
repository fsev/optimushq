/**
 * MCP Bridge — HTTP endpoint for JSON-RPC requests from agent containers.
 *
 * POST /api/mcp-bridge?sessionId=xxx&userId=yyy
 * Body: JSON-RPC request
 * Response: JSON-RPC response
 *
 * Registered BEFORE auth middleware so Docker-networked agents can reach it.
 * Validates the session exists in the DB for basic authorization.
 */

import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/connection.js';
import {
  handleInitialize,
  handleToolsList,
  handleToolCall,
  type McpContext,
} from '../mcp/tool-handlers.js';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || '';
  const userId = (req.query.userId as string) || '';

  const db = getDb();

  // Validate session exists (basic authorization)
  if (sessionId) {
    const sess = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as { id: string } | undefined;
    if (!sess) {
      return res.status(403).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'Invalid session' },
      });
    }
  }

  const msg = req.body;
  if (!msg || !msg.method) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: msg?.id ?? null,
      error: { code: -32600, message: 'Invalid request: missing method' },
    });
  }

  const ctx: McpContext = {
    userId: userId || null,
    sessionId: sessionId || null,
    db,
  };

  // Handle notifications (no response needed, but return 200)
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
    return res.json({ jsonrpc: '2.0', id: msg.id ?? null, result: {} });
  }

  switch (msg.method) {
    case 'initialize':
      return res.json(handleInitialize(msg.id));
    case 'tools/list':
      return res.json(handleToolsList(msg.id));
    case 'tools/call': {
      const result = handleToolCall(msg.id, msg.params, ctx);
      if (result instanceof Promise) {
        return result.then(r => res.json(r)).catch(err => {
          res.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
        });
      }
      return res.json(result);
    }
    default:
      return res.json({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
  }
});

export default router;
