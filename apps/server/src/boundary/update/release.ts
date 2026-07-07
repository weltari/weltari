// Release metadata shapes (B-update). GitHub's release JSON is a third-party
// payload: plain z.object, unknown keys stripped and never trusted (Guide B5).
// Everything here is METADATA — the artifact itself is trusted only after the
// verifier's SHA-256 + minisign checks (Guide B12).
import { z } from 'zod';

export const ReleaseAssetSchema = z.object({
  name: z.string().min(1),
  browser_download_url: z.string().min(1),
});
export type ReleaseAsset = z.infer<typeof ReleaseAssetSchema>;

/** GitHub /releases/latest response — the fields the updater reads. */
export const ReleaseSchema = z.object({
  tag_name: z.string().min(1),
  html_url: z.string().min(1).optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(ReleaseAssetSchema).default([]),
});
export type Release = z.infer<typeof ReleaseSchema>;

/** Artifact naming contract with the packaging script (docs/update.md). */
export function artifactName(
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `weltari-app-${version}-${platform}-${arch}.tar.gz`;
}

export interface UpdateAssets {
  artifact: ReleaseAsset;
  signature: ReleaseAsset;
  sha256: ReleaseAsset;
}

/** The artifact + its .minisig + its .sha256, or null if any is missing. */
export function pickUpdateAssets(
  release: Release,
  version: string,
  platform: string = process.platform,
  arch: string = process.arch,
): UpdateAssets | null {
  const base = artifactName(version, platform, arch);
  const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
  const artifact = byName.get(base);
  const signature = byName.get(`${base}.minisig`);
  const sha256 = byName.get(`${base}.sha256`);
  if (artifact === undefined || signature === undefined || sha256 === undefined)
    return null;
  return { artifact, signature, sha256 };
}
