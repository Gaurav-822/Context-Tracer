/**
 * Smoke-test the bundled MCP stdio server (no placeholder paths).
 * Usage (from extension repo, after `npm run build`):
 *   npm run test:mcp
 *   npm run test:mcp -- /absolute/path/to/workspace
 *
 * Or set EXPLORER_MAP_WORKSPACE_ROOT and run node with the absolute path to
 * `dist/mcp-md-handler/index.js` (extension repo) or the same under your installed extension folder.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const handler = path.join(__dirname, '..', 'dist', 'mcp-md-handler', 'index.js');
if (!fs.existsSync(handler)) {
  console.error('Bundled handler not found at:\n  ' + handler);
  console.error('From the extension repo, run: npm run build');
  process.exit(1);
}

const workspaceRoot = path.resolve(
  process.argv[2] || process.env.EXPLORER_MAP_WORKSPACE_ROOT || process.cwd()
);

const init = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-mcp-stdio', version: '1.0.0' },
  },
};

console.log('Handler:     ', handler);
console.log('Workspace:   ', workspaceRoot);
console.log('Request line:', JSON.stringify(init));
console.log('--- response (stdout) ---\n');

const child = spawn(process.execPath, [handler], {
  env: { ...process.env, EXPLORER_MAP_WORKSPACE_ROOT: workspaceRoot },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let out = '';
let err = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (d) => {
  out += d;
});
child.stderr.on('data', (d) => {
  err += d;
});

child.stdin.write(JSON.stringify(init) + '\n');

const killTimer = setTimeout(() => {
  child.kill();
  if (out.trim()) {
    console.log(out);
  } else {
    console.log('(no stdout — server may use a different protocol version)');
  }
  if (err.trim()) {
    console.log('--- stderr ---\n' + err);
  }
  process.exit(out.trim() || err.trim() ? 0 : 1);
}, 2000);

child.on('error', (e) => {
  clearTimeout(killTimer);
  console.error(e);
  process.exit(1);
});
