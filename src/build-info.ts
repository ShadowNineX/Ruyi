declare const __RUYI_GIT_COMMIT__: string | undefined;
declare const __RUYI_BUILD_TIME__: string | undefined;

const DEVELOPMENT_COMMIT = "development";

export interface BuildInfo {
  commit: string;
  shortCommit: string;
  buildTime: string | null;
  bundled: boolean;
}

function readBundledString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBundledCommit(): string | null {
  return readBundledString(
    typeof __RUYI_GIT_COMMIT__ === "undefined"
      ? null
      : __RUYI_GIT_COMMIT__,
  );
}

function readBundledBuildTime(): string | null {
  return readBundledString(
    typeof __RUYI_BUILD_TIME__ === "undefined"
      ? null
      : __RUYI_BUILD_TIME__,
  );
}

export function formatShortCommit(commit: string): string {
  if (commit === DEVELOPMENT_COMMIT || commit === "unknown") return commit;
  return commit.slice(0, 12);
}

export function getBuildInfo(): BuildInfo {
  const commit = readBundledCommit() ?? DEVELOPMENT_COMMIT;
  const buildTime = readBundledBuildTime();

  return {
    commit,
    shortCommit: formatShortCommit(commit),
    buildTime,
    bundled: commit !== DEVELOPMENT_COMMIT || buildTime !== null,
  };
}
