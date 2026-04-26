const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function copyScripts() {
  const srcDir = path.join(__dirname, 'src', 'scripts');
  const destDir = path.join(__dirname, 'dist', 'scripts');
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  for (const file of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  // usedImports.ts is imported by scripts; copy to dist for ts-node
  const usedImportsSrc = path.join(__dirname, 'src', 'usedImports.ts');
  const usedImportsDest = path.join(__dirname, 'dist', 'usedImports.ts');
  if (fs.existsSync(usedImportsSrc)) {
    fs.copyFileSync(usedImportsSrc, usedImportsDest);
  }
}

function copyMcpBundleArtifacts() {
  const mcpDistSrc = path.join(__dirname, 'mcp-md-handler', 'dist', 'index.js');
  const mcpReadmeSrc = path.join(__dirname, 'mcp-md-handler', 'README.md');
  const mcpDistDestDir = path.join(__dirname, 'dist', 'mcp-md-handler');
  if (!fs.existsSync(mcpDistSrc)) {
    throw new Error('Missing mcp-md-handler/dist/index.js. Run mcp-md-handler build first.');
  }
  fs.mkdirSync(mcpDistDestDir, { recursive: true });
  fs.copyFileSync(mcpDistSrc, path.join(mcpDistDestDir, 'index.js'));
  if (fs.existsSync(mcpReadmeSrc)) {
    fs.copyFileSync(mcpReadmeSrc, path.join(mcpDistDestDir, 'README.md'));
  }
}

async function main() {
  // Always build MCP server first, then bundle extension and copy artifacts into dist/.
  await esbuild.context({
    entryPoints: [path.join(__dirname, 'mcp-md-handler', 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(__dirname, 'mcp-md-handler', 'dist', 'index.js'),
    sourcemap: !production,
    logLevel: 'silent',
  }).then(async (mcpCtx) => {
    await mcpCtx.rebuild();
    await mcpCtx.dispose();
  });

  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    // Keep extension host code unminified to avoid packaged-only runtime regressions.
    minify: false,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    // Only `vscode` is provided by the host; everything else (incl. typescript)
    // must be bundled because the packaged VSIX does not ship node_modules.
    external: ['vscode'],
    logLevel: 'silent',
  });
  if (watch) {
    await ctx.watch();
    copyScripts();
    copyMcpBundleArtifacts();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    copyScripts();
    copyMcpBundleArtifacts();
    console.log('Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
