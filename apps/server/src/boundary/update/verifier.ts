// The B12 verifier: an update artifact becomes trusted ONLY here, and the
// proof is the VerifiedArtifact value — its class is not exported (type-only
// below) and its constructor is private, so no other module can construct or
// structurally fake one. The pointer-flip path (stage.ts) demands this type:
// the compiler refuses any code path that skips verification.
import { createHash } from 'node:crypto';
import type { Buffer } from 'node:buffer';
import { err, ok, OperationalError, type Result } from '../../errors.js';
import { verifyMinisign } from './minisign.js';

interface VerifiedArtifactProps {
  version: string;
  sha256: string;
  bytes: Buffer;
}

class VerifiedArtifact {
  readonly #props: VerifiedArtifactProps;

  private constructor(props: VerifiedArtifactProps) {
    this.#props = props;
  }

  get version(): string {
    return this.#props.version;
  }

  get sha256(): string {
    return this.#props.sha256;
  }

  /** The verified artifact bytes — what the hash and signature actually cover. */
  get bytes(): Buffer {
    return this.#props.bytes;
  }

  /** Module-internal: reachable only through verifyArtifact (class not exported). */
  static seal(props: VerifiedArtifactProps): VerifiedArtifact {
    return new VerifiedArtifact(props);
  }
}

export type { VerifiedArtifact };

export interface VerifyArtifactInput {
  version: string;
  /** The downloaded artifact bytes. */
  artifact: Buffer;
  /** Expected hex SHA-256 (first token of the published .sha256 asset). */
  expectedSha256: string;
  /** The .minisig signature file text. */
  signatureText: string;
  /** The minisign public key (base64 body line). */
  publicKeyBase64: string;
}

/**
 * SHA-256 AND minisign must both pass (Guide B12); the caller deletes the
 * download on any failure and the running version stays untouched.
 */
export function verifyArtifact(
  input: VerifyArtifactInput,
): Result<VerifiedArtifact> {
  const expected = input.expectedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return err(
      new OperationalError(
        'update_hash_invalid',
        'published SHA-256 malformed',
      ),
    );
  }
  const actual = createHash('sha256').update(input.artifact).digest('hex');
  if (actual !== expected) {
    return err(
      new OperationalError(
        'update_hash_mismatch',
        `artifact SHA-256 ${actual} != published ${expected}`,
      ),
    );
  }
  const signature = verifyMinisign(
    input.artifact,
    input.signatureText,
    input.publicKeyBase64,
  );
  if (!signature.ok) {
    return err(
      new OperationalError(
        'update_signature_rejected',
        `minisign verification failed: ${signature.reason}`,
      ),
    );
  }
  return ok(
    VerifiedArtifact.seal({
      version: input.version,
      sha256: actual,
      bytes: input.artifact,
    }),
  );
}
