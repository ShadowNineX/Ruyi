import { stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { $ } from 'bun';

const entrypoint = 'src/main.ts';
const outdir = 'dist';
const outfile = join(
  outdir,
  `${basename(entrypoint, extname(entrypoint))}.js`,
);

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

async function getGitCommit(): Promise<string> {
  const commit = await $`git rev-parse HEAD`.text();
  return commit.trim();
}

const gitCommit = await getGitCommit();
const buildTime = new Date().toISOString();

const result = await Bun.build({
  entrypoints: [entrypoint],
  target: 'bun',
  packages: 'external',
  outdir,
  define: {
    __RUYI_BUILD_TIME__: JSON.stringify(buildTime),
    __RUYI_GIT_COMMIT__: JSON.stringify(gitCommit),
  },
});

for (const log of result.logs) {
  console.error(log);
}

if (!result.success) {
  process.exit(1);
}

const outputStats = await stat(outfile);

console.info(
  `Built ${entrypoint} -> ${outfile} (${formatBytes(outputStats.size)}, ${outputStats.size} bytes)`,
);
console.info(`Commit: ${gitCommit}`);
console.info(`Build time: ${buildTime}`);
