/**
 * MCP stdio-to-HTTP proxy script that runs inside agent containers.
 *
 * The script is delivered as a string constant via the MCP_PROXY_SCRIPT
 * environment variable and written to /tmp/mcp-proxy.js at container start.
 *
 * It reads JSON-RPC lines from stdin (sent by Claude Code), POSTs each to the
 * platform's MCP bridge endpoint, and writes the response to stdout.
 */

export const MCP_PROXY_SCRIPT = `
const http = require('http');
const readline = require('readline');

const SESSION_ID = process.env.SESSION_ID || '';
const USER_ID = process.env.USER_ID || '';
const BRIDGE_HOST = process.env.MCP_BRIDGE_HOST || 'optimushq';
const BRIDGE_PORT = parseInt(process.env.MCP_BRIDGE_PORT || '3001', 10);

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;

  const body = Buffer.from(line, 'utf-8');
  const req = http.request({
    hostname: BRIDGE_HOST,
    port: BRIDGE_PORT,
    path: '/api/mcp-bridge?sessionId=' + encodeURIComponent(SESSION_ID) + '&userId=' + encodeURIComponent(USER_ID),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      process.stdout.write(data + '\\n');
    });
  });

  req.on('error', (err) => {
    // Return a JSON-RPC error so Claude Code doesn't hang
    try {
      const parsed = JSON.parse(line);
      const errResp = JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id,
        error: { code: -32000, message: 'MCP bridge error: ' + err.message },
      });
      process.stdout.write(errResp + '\\n');
    } catch {
      // Can't parse — ignore
    }
  });

  req.write(body);
  req.end();
});

rl.on('close', () => { process.exit(0); });
`.trim();
