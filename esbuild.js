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

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode', 'typescript'],
    logLevel: 'silent',
  });
  if (watch) {
    await ctx.watch();
    copyScripts();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    copyScripts();
    console.log('Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
