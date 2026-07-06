import { describe, expect, it } from 'vitest';
import { mapUpdate } from './connector.js';

describe('telegram update mapping (own schema — B7)', () => {
  it('maps a plain text message, chat-prefixing the dedup id', () => {
    const raw: unknown = {
      update_id: 9000,
      message: {
        message_id: 1001,
        chat: { id: 42, type: 'private' },
        from: { id: 7, is_bot: false, first_name: 'X' },
        date: 1751846400,
        text: 'Hello',
      },
    };
    expect(mapUpdate(raw)).toEqual({
      external_msg_id: '42:1001',
      conversation_id: '42',
      text: 'Hello',
    });
  });

  it('ignores non-text messages and unknown update kinds', () => {
    const sticker: unknown = {
      update_id: 9001,
      message: { message_id: 1002, chat: { id: 42 }, sticker: {} },
    };
    expect(mapUpdate(sticker)).toBeNull();
    const editedMessage: unknown = {
      update_id: 9002,
      edited_message: { message_id: 1003, chat: { id: 42 }, text: 'edit' },
    };
    expect(mapUpdate(editedMessage)).toBeNull();
  });

  it('rejects malformed updates instead of trusting library types', () => {
    expect(mapUpdate(null)).toBeNull();
    expect(mapUpdate('string')).toBeNull();
    expect(
      mapUpdate({ message: { message_id: 'not-a-number', chat: { id: 42 } } }),
    ).toBeNull();
    expect(
      mapUpdate({ message: { message_id: 1, text: 'no chat' } }),
    ).toBeNull();
  });

  it('strips unknown keys instead of failing (loose third-party schema, B5)', () => {
    const withNewField: unknown = {
      message: {
        message_id: 1005,
        chat: { id: 42 },
        text: 'hi',
        brand_new_telegram_feature: { x: 1 },
      },
    };
    expect(mapUpdate(withNewField)).toEqual({
      external_msg_id: '42:1005',
      conversation_id: '42',
      text: 'hi',
    });
  });
});
