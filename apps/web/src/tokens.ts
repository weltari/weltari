// Duration tokens live in theme.css (§1.14 / structure.md rule 6); JS reads
// them through this helper and never owns them — a reskin retunes every
// animation without touching a component.
export function readTokenMs(token: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  const match = /^([\d.]+)(ms|s)$/.exec(raw);
  if (match?.[1] === undefined) return fallback;
  const value = Number(match[1]);
  return match[2] === 's' ? value * 1000 : value;
}
