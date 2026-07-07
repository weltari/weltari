// Test-only minisign SIGNER (the server verifies, never signs). Generates a
// throwaway Ed25519 keypair and produces the exact wire format the B12
// verifier consumes: prehashed ('ED') signatures over BLAKE2b-512, plus the
// global signature over (signature || trusted_comment). Compiled into
// tests/dist so the kill harness (tools/*.mjs) reuses the same implementation.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as ed25519Sign,
  type KeyObject,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

export interface MinisignKeypair {
  /** base64('Ed' || key_id[8] || pubkey[32]) — what WELTARI_UPDATE_PUBKEY holds. */
  publicKeyBase64: string;
  keyId: Buffer;
  privateKey: KeyObject;
}

export function generateMinisignKeypair(): MinisignKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(spki.subarray(spki.length - 32));
  const keyId = randomBytes(8);
  const blob = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, raw]);
  return { publicKeyBase64: blob.toString('base64'), keyId, privateKey };
}

export interface SignOptions {
  /** 'ED' (prehashed, default) or legacy pure 'Ed'. */
  algorithm?: 'ED' | 'Ed';
  trustedComment?: string;
}

/** Produce the full .minisig file text for `content`. */
export function minisignSign(
  content: Buffer,
  keypair: MinisignKeypair,
  options: SignOptions = {},
): string {
  const algorithm = options.algorithm ?? 'ED';
  const trustedComment = options.trustedComment ?? 'timestamp:0\tfile:artifact';
  const message =
    algorithm === 'ED'
      ? createHash('blake2b512').update(content).digest()
      : content;
  const signature = ed25519Sign(null, message, keypair.privateKey);
  const globalSignature = ed25519Sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]),
    keypair.privateKey,
  );
  const sigBlob = Buffer.concat([
    Buffer.from(algorithm, 'latin1'),
    keypair.keyId,
    signature,
  ]);
  return [
    'untrusted comment: weltari test signature',
    sigBlob.toString('base64'),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
}
