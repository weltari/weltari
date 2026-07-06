import { expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './index.js';

it('PROTOCOL_VERSION is plain semver (handshake contract)', () => {
  expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
