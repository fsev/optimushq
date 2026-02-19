#!/usr/bin/env tsx
/**
 * Project Manager MCP Server (stdio transport)
 *
 * Implements Model Context Protocol (JSON-RPC 2.0 over stdio) to expose
 * project management tools to Claude agents.
 *
 * Tool logic lives in ../mcp/tool-handlers.ts (shared with the HTTP bridge).
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { createInterface } from 'readline';
import {
  handleInitialize,
  handleToolsList,
  handleToolCall,
  type McpContext,
} from '../mcp/tool-handlers.js';

// --- DB setup (same path as main server) ---
const DB_PATH = join(import.meta.dirname || new URL('.', import.meta.url).pathname, '..', '..', '..', 'chat.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Get user_id and session_id from env (passed by spawn.ts)
const ctx: McpContext = {
  userId: process.env.USER_ID || null,
  sessionId: process.env.SESSION_ID || null,
  db,
};

// --- stdio transport ---

function send(msg: unknown) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);

    // Handle notifications (no id)
    if (msg.method === 'notifications/initialized') return;
    if (msg.method === 'notifications/cancelled') return;

    switch (msg.method) {
      case 'initialize':
        send(handleInitialize(msg.id));
        break;
      case 'tools/list':
        send(handleToolsList(msg.id));
        break;
      case 'tools/call': {
        const result = handleToolCall(msg.id, msg.params, ctx);
        if (result instanceof Promise) {
          result.then(send).catch((err: any) => {
            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
          });
        } else {
          send(result);
        }
        break;
      }
      default:
        if (msg.id !== undefined) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
        }
    }
  } catch (err: any) {
    // Try to extract id for error response
    try {
      const parsed = JSON.parse(line);
      send({ jsonrpc: '2.0', id: parsed.id, error: { code: -32700, message: err.message } });
    } catch {
      // Can't even parse — ignore
    }
  }
});

rl.on('close', () => {
  db.close();
  process.exit(0);
});
