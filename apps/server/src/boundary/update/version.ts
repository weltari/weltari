// Plain-semver helpers for the update channel. Release tags are untrusted
// metadata (Guide B12): anything that doesn't parse as MAJOR.MINOR.PATCH
// (optional leading 'v') is simply "not a newer version" — never a crash.

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(tag: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined)
    return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

/** True when `candidate` is a valid version strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch > b.patch;
}

/** Canonical form without the leading 'v' ("v0.2.0" → "0.2.0"); null if invalid. */
export function normalizeVersion(tag: string): string | null {
  const parsed = parseVersion(tag);
  if (parsed === null) return null;
  return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}`;
}
