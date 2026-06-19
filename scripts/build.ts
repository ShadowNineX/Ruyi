import { $ } from 'bun';

const entrypoint = 'src/main.ts';
const outdir = 'dist';

async function getGitCommit(): Promise<string> {
  try {
    const commit = await $`git rev-parse HEAD`.text();
    return commit.trim() || 'unknown';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not read Git commit for build: ${message}`);
    return 'unknown';
  }
}

const gitCommit = await getGitCommit();
const buildTime = new Date().toISOString();

const result = await Bun.build({
  entrypoints: [entrypoint],
  target: 'bun',
  packages: 'external',
  outdir,
  define: {
    __RUYI_GIT_COMMIT__: JSON.stringify(gitCommit),
    __RUYI_BUILD_TIME__: JSON.stringify(buildTime),
  },
});

for (const log of result.logs) {
  console.error(log);
}

if (!result.success) {
  process.exit(1);
}

console.info(`Built ${entrypoint} -> ${outdir}`);
console.info(`Commit: ${gitCommit}`);
console.info(`Build time: ${buildTime}`);
