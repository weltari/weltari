// World flags as folds (M7 part 2, Rev 4 §15): no mutable settings table —
// a flag's state is the latest config.flag_set event for it, like every
// other projection here. profiling_enabled defaults OFF: profiling is
// consent-first (Rev 4 §9 GDPR guardrails) — the user flips it in Config
// (or asks the GM to, in a later week).
import type { SetConfigFlagCommand, WeltariEvent } from '@weltari/protocol';
import { ok, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import type { EventSink } from './event-sink.js';

type ConfigFlag = Extract<
  WeltariEvent,
  { type: 'config.flag_set' }
>['payload']['flag'];

const FLAG_DEFAULTS: Record<ConfigFlag, boolean> = {
  profiling_enabled: false,
};

/** The latest-wins fold for one flag (folds every flag, answers one — the
 * enum is tiny and the log scan dominates either way). */
export function flagOf(
  storage: Storage,
  worldId: string,
  flag: ConfigFlag,
): boolean {
  const values: Record<ConfigFlag, boolean> = { ...FLAG_DEFAULTS };
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'config.flag_set') {
      values[event.payload.flag] = event.payload.value;
    }
  }
  return values[flag];
}

export interface SetConfigFlagOptions {
  sink: EventSink;
}

export function createSetConfigFlagCommand(
  options: SetConfigFlagOptions,
): (command: SetConfigFlagCommand) => Result<{ flag: string; value: boolean }> {
  return (command): Result<{ flag: string; value: boolean }> => {
    options.sink.append({
      world_id: command.world_id,
      actor_id: command.actor_id,
      type: 'config.flag_set',
      payload: { flag: command.flag, value: command.value },
    });
    return ok({ flag: command.flag, value: command.value });
  };
}
