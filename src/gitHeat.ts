import { execFileSync } from 'child_process';

/**
 * For each relative repo path in `paths`, counts how often that file appears in
 * `git log` (last 90 days, no merges). Used to highlight recently touched files.
 */
export function computeGitHeatByPath(cwd: string, paths: string[]): Record<string, number> {
  const heat: Record<string, number> = Object.fromEntries(paths.map((p) => [p, 0]));
  const normToKey = new Map<string, string>();
  for (const p of paths) {
    normToKey.set(p.replace(/\\/g, '/'), p);
  }

  let output: string;
  try {
    output = execFileSync(
      'git',
      ['log', '--since=90.days.ago', '--pretty=format:', '--name-only', '--no-merges'],
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } catch {
    return heat;
  }

  for (const line of output.split(/\r?\n/)) {
    const n = line.replace(/\\/g, '/').trim();
    if (!n || n.includes('..')) continue;
    const key = normToKey.get(n);
    if (key !== undefined) {
      heat[key] += 1;
    }
  }
  return heat;
}
