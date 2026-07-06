import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../db.js';

describe('gateway repository (exactly-once ingestion, B7)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): Storage {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-gateway-repo-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    return storage;
  }

  it('first insert true, duplicate false (UNIQUE silent drop)', () => {
    const s = setup();
    const message = {
      connector_id: 'telegram',
      external_msg_id: '42:1001',
      conversation_id: '42',
      text: 'hello',
    };
    expect(s.gateway.recordInbound(message)).toBe(true);
    expect(s.gateway.recordInbound(message)).toBe(false);
  });

  it('the pair is the key: same msg id on another connector is distinct', () => {
    const s = setup();
    expect(
      s.gateway.recordInbound({
        connector_id: 'telegram',
        external_msg_id: 'm1',
        conversation_id: 'c1',
        text: 'a',
      }),
    ).toBe(true);
    expect(
      s.gateway.recordInbound({
        connector_id: 'wechat',
        external_msg_id: 'm1',
        conversation_id: 'c1',
        text: 'a',
      }),
    ).toBe(true);
  });
});
