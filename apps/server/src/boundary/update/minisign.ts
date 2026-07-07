// Minisign VERIFICATION (Guide B12), implemented on node:crypto (Ed25519 +
// BLAKE2b-512) — zero dependencies; this module never signs. Format per
// jedisct1/minisign:
//   public key  = base64('Ed' || key_id[8] || pubkey[32])
//   .minisig    = line 1 'untrusted comment: …'
//                 line 2 base64(alg[2] || key_id[8] || signature[64])
//                 line 3 'trusted comment: …'
//                 line 4 base64(global_sig[64])
// alg 'ED' = prehashed (Ed25519 over BLAKE2b-512(file), minisign's default);
// alg 'Ed' = legacy pure mode (Ed25519 over the file). The global signature
// signs (signature || trusted_comment) — a tampered trusted comment fails too.
import {
  createHash,
  createPublicKey,
  verify as ed25519Verify,
  type KeyObject,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

/** DER prefix wrapping a raw Ed25519 public key as SPKI (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const KEY_ID_LENGTH = 8;
const PUBKEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

export type MinisignResult = { ok: true } | { ok: false; reason: string };

interface ParsedPublicKey {
  keyId: Buffer;
  key: KeyObject;
}

function decodeBase64(text: string): Buffer | null {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  return Buffer.from(trimmed, 'base64');
}

function parsePublicKey(publicKeyBase64: string): ParsedPublicKey | null {
  const decoded = decodeBase64(publicKeyBase64);
  if (decoded?.length !== 2 + KEY_ID_LENGTH + PUBKEY_LENGTH) return null;
  if (decoded.toString('latin1', 0, 2) !== 'Ed') return null;
  const raw = decoded.subarray(2 + KEY_ID_LENGTH);
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return { keyId: decoded.subarray(2, 2 + KEY_ID_LENGTH), key };
}

interface ParsedSignature {
  algorithm: 'Ed' | 'ED';
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

const TRUSTED_PREFIX = 'trusted comment: ';

function parseSignatureText(signatureText: string): ParsedSignature | null {
  const lines = signatureText.split(/\r?\n/);
  const sigLine = lines[1];
  const trustedLine = lines[2];
  const globalLine = lines[3];
  if (
    sigLine === undefined ||
    trustedLine === undefined ||
    globalLine === undefined
  )
    return null;
  const sigBlob = decodeBase64(sigLine);
  if (sigBlob?.length !== 2 + KEY_ID_LENGTH + SIGNATURE_LENGTH) return null;
  const algorithm = sigBlob.toString('latin1', 0, 2);
  if (algorithm !== 'Ed' && algorithm !== 'ED') return null;
  if (!trustedLine.startsWith(TRUSTED_PREFIX)) return null;
  const globalSignature = decodeBase64(globalLine);
  if (globalSignature?.length !== SIGNATURE_LENGTH) return null;
  return {
    algorithm,
    keyId: sigBlob.subarray(2, 2 + KEY_ID_LENGTH),
    signature: sigBlob.subarray(2 + KEY_ID_LENGTH),
    trustedComment: trustedLine.slice(TRUSTED_PREFIX.length),
    globalSignature,
  };
}

/**
 * Verify `content` against a minisign signature file and public key. Pure
 * check — no filesystem, no throw: every malformed input is a `reason`.
 */
export function verifyMinisign(
  content: Buffer,
  signatureText: string,
  publicKeyBase64: string,
): MinisignResult {
  const publicKey = parsePublicKey(publicKeyBase64);
  if (publicKey === null) return { ok: false, reason: 'public_key_invalid' };
  const parsed = parseSignatureText(signatureText);
  if (parsed === null) return { ok: false, reason: 'signature_file_invalid' };
  if (!parsed.keyId.equals(publicKey.keyId))
    return { ok: false, reason: 'key_id_mismatch' };
  const message =
    parsed.algorithm === 'ED'
      ? createHash('blake2b512').update(content).digest()
      : content;
  if (!ed25519Verify(null, message, publicKey.key, parsed.signature))
    return { ok: false, reason: 'signature_invalid' };
  const globalMessage = Buffer.concat([
    parsed.signature,
    Buffer.from(parsed.trustedComment, 'utf8'),
  ]);
  if (
    !ed25519Verify(null, globalMessage, publicKey.key, parsed.globalSignature)
  )
    return { ok: false, reason: 'global_signature_invalid' };
  return { ok: true };
}
