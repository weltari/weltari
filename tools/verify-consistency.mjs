// Post-crash consistency verifier (Invariant I4). Exits 1 with reasons on any
// violation. Raw driver access is sanctioned under tools/ (Guide A11) — this
// runs OFFLINE against the database file, after the process was SIGKILLed.
// Usage: node tools/verify-consistency.mjs <db-path> [<images-dir>]
//   <images-dir> enables the M2 painter hash check (criterion a: zero
//   corrupted images) — required when painter.completed events exist.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
const imagesDir = process.argv[3] ?? process.env.WELTARI_IMAGES_DIR;
if (!dbPath) {
  console.error(
    'usage: node tools/verify-consistency.mjs <db-path> [<images-dir>]',
  );
  process.exit(2);
}

const failures = [];
// Opening the file performs the same WAL recovery the real startup performs.
const db = new Database(dbPath);

// 1. SQLite-level integrity
const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') failures.push(`integrity_check: ${String(integrity)}`);

// 2. Event ids strictly increasing and unique (append-only log, I1/I4)
const ids = db
  .prepare('SELECT id FROM events ORDER BY id')
  .all()
  .map((r) => r.id);
for (let i = 1; i < ids.length; i++) {
  if (!(ids[i] > ids[i - 1])) {
    failures.push(
      `event ids not strictly increasing at index ${i}: ${ids[i - 1]} -> ${ids[i]}`,
    );
    break;
  }
}

// 3. Every payload is valid JSON with a scene/turn shape the engine could have written
// (actor_id rides along for the provenance checks — 4p's movement sweep).
const events = db
  .prepare(
    'SELECT id, world_id, actor_id, type, payload FROM events ORDER BY id',
  )
  .all();
for (const event of events) {
  try {
    JSON.parse(event.payload);
  } catch {
    failures.push(`event ${event.id} payload is not JSON`);
  }
}

// 4. Turn envelope discipline (B6): at most one committed per turn_id, and
//    every committed turn has its started envelope. Started-without-committed
//    is EXPECTED (a killed turn voids) — never the reverse.
const started = new Set();
const committed = new Map();
for (const event of events) {
  const payload = JSON.parse(event.payload);
  if (event.type === 'turn.started') started.add(payload.turn_id);
  if (event.type === 'turn.committed') {
    committed.set(payload.turn_id, (committed.get(payload.turn_id) ?? 0) + 1);
  }
}
for (const [turnId, count] of committed) {
  if (count > 1)
    failures.push(`turn ${turnId} committed ${count} times (duplicate)`);
  if (!started.has(turnId))
    failures.push(`turn ${turnId} committed without turn.started`);
}

// 4b. Scene-end fan-out atomicity (M2, Brief §2.4): a scene.ended event can
//     only exist alongside ALL of its jobs — one WriteGate transaction wrote
//     them, so a kill can never leave the event without the rows.
const jobKeyExists = db.prepare(
  'SELECT COUNT(*) AS n FROM ledger_jobs WHERE idempotency_key = ?',
);
for (const event of events) {
  if (event.type !== 'scene.ended') continue;
  const payload = JSON.parse(event.payload);
  for (const participant of payload.participants) {
    const key = `reflection:${participant}:${payload.scene_id}`;
    if (jobKeyExists.get(key).n !== 1) {
      failures.push(`scene.ended ${payload.scene_id}: missing job ${key}`);
    }
  }
  const worldAgentKey = `world_agent:${payload.scene_id}`;
  if (jobKeyExists.get(worldAgentKey).n !== 1) {
    failures.push(
      `scene.ended ${payload.scene_id}: missing job ${worldAgentKey}`,
    );
  }
}

// 4c. Idempotent projections stayed idempotent under kill-retry (M2): every
//     cold-path outcome event is unique per its natural key.
const seenOnce = new Map();
const dupCheck = (kind, key, eventId) => {
  const mapKey = `${kind}|${key}`;
  if (seenOnce.has(mapKey)) {
    failures.push(
      `duplicate ${kind} for ${key} (events ${seenOnce.get(mapKey)} and ${eventId})`,
    );
  } else {
    seenOnce.set(mapKey, eventId);
  }
};
for (const event of events) {
  const payload = JSON.parse(event.payload);
  if (event.type === 'reflection.committed') {
    dupCheck(
      'reflection.committed',
      `${payload.scene_id}:${payload.character_id}`,
      event.id,
    );
  }
  if (event.type === 'world_agent.committed') {
    dupCheck('world_agent.committed', payload.scene_id, event.id);
  }
  if (event.type === 'world_cron.completed') {
    dupCheck(
      'world_cron.completed',
      `${payload.cron_type}:${payload.scheduled_for}`,
      event.id,
    );
  }
  if (event.type === 'painter.completed') {
    dupCheck('painter.completed', payload.job_key, event.id);
  }
  if (event.type === 'update.staged') {
    dupCheck('update.staged', payload.version, event.id);
  }
  if (event.type === 'sublocation.materialized') {
    dupCheck(
      'sublocation.materialized',
      `${event.world_id}:${payload.square.col}:${payload.square.row}`,
      event.id,
    );
    // M6 part 1: a Narrator stub materializes at most once — the natural key
    // is the stub id, not just the (solver-chosen) square.
    dupCheck(
      'sublocation.materialized:id',
      `${event.world_id}:${payload.sublocation_id}`,
      event.id,
    );
  }
  if (event.type === 'sublocation.stub_created') {
    dupCheck(
      'sublocation.stub_created',
      `${event.world_id}:${payload.sublocation_id}`,
      event.id,
    );
  }
  if (event.type === 'sublocation.created') {
    dupCheck(
      'sublocation.created',
      `${event.world_id}:${payload.edit_id}`,
      event.id,
    );
  }
  if (event.type === 'map_click.resolved') {
    dupCheck(
      'map_click.resolved',
      `${event.world_id}:${payload.click_id}`,
      event.id,
    );
  }
  // M6 part 2 (Weltari Chat): user/character messages are unique per
  // (conversation, message_id) — duplicate sends and kill-retries never twin.
  if (event.type === 'chat.message_committed') {
    dupCheck(
      'chat.message_committed',
      `${payload.conversation_id}:${payload.message_id}`,
      event.id,
    );
  }
  // A conversation range closes at most once (chat.ended per range end)…
  if (event.type === 'chat.ended') {
    dupCheck(
      'chat.ended',
      `${payload.conversation_id}:${payload.range_end_id}`,
      event.id,
    );
  }
  // …and reflects at most once (the reflect_chat natural key).
  if (event.type === 'reflect_chat.committed') {
    dupCheck(
      'reflect_chat.committed',
      `${payload.conversation_id}:${payload.range_end_id}`,
      event.id,
    );
  }
  // M6 part 2 (Rev 4 §10): one subwiki entry per scene per sublocation —
  // the World Agent's pass rides world_agent.committed's transaction.
  if (event.type === 'subwiki.updated') {
    dupCheck(
      'subwiki.updated',
      `${payload.scene_id}:${payload.sublocation_id}`,
      event.id,
    );
  }
  // M6 part 3 (Rev 4 §8): one scheduler fire commits at most one outreach —
  // the proactive_dm natural key (world, occurrence) survives kill-retries.
  if (event.type === 'chat.outreach_recorded') {
    dupCheck(
      'chat.outreach_recorded',
      `${event.world_id}:${payload.occurrence_iso}`,
      event.id,
    );
  }
  // M6 part 4 (Rev 4 §7): one expiry per scene ever — the invitation's
  // natural key survives kill-retries and racing sweeps.
  if (event.type === 'scene.expired') {
    dupCheck('scene.expired', payload.scene_id, event.id);
  }
  // M6 part 4 (Rev 4 §8, groups): lines unique per (conversation, message);
  // a range closes at most once per range end.
  if (event.type === 'chat.group_message_committed') {
    dupCheck(
      'chat.group_message_committed',
      `${payload.conversation_id}:${payload.message_id}`,
      event.id,
    );
  }
  if (event.type === 'chat.group_ended') {
    dupCheck(
      'chat.group_ended',
      `${payload.conversation_id}:${payload.range_end_id}`,
      event.id,
    );
  }
  // …and a thread freezes at most once per tripping outreach.
  if (event.type === 'chat.thread_frozen') {
    dupCheck(
      'chat.thread_frozen',
      `${payload.conversation_id}:${payload.message_id}`,
      event.id,
    );
  }
}

// 4i. Outreach atomicity (M6 part 3, Rev 4 §8): every chat.outreach_recorded
//     commits in ONE transaction with the chat.message_committed it delivered
//     — the record without its message is a torn transaction. And every
//     chat.thread_frozen must sit on an outreach whose count reached the cap.
{
  const messageKeys = new Set();
  for (const event of events) {
    if (event.type !== 'chat.message_committed') continue;
    const payload = JSON.parse(event.payload);
    messageKeys.add(`${payload.conversation_id}:${payload.message_id}`);
  }
  for (const event of events) {
    if (event.type === 'chat.outreach_recorded') {
      const payload = JSON.parse(event.payload);
      if (
        !messageKeys.has(`${payload.conversation_id}:${payload.message_id}`)
      ) {
        failures.push(
          `chat.outreach_recorded ${payload.occurrence_iso}: missing its delivered message ${payload.message_id} (torn transaction)`,
        );
      }
    }
    if (event.type === 'chat.thread_frozen') {
      const payload = JSON.parse(event.payload);
      if (payload.unanswered_count < 3) {
        failures.push(
          `chat.thread_frozen ${payload.conversation_id}: froze below the 3-unanswered cap (${payload.unanswered_count})`,
        );
      }
    }
  }
}

// 4j. Invitation-expiry atomicity (M6 part 4, Rev 4 §7): every scene.expired
//     commits in ONE transaction with its hardcoded absence cache entry; it
//     may only close a never-entered invitation scene, and never coexists
//     with a scene.ended for the same scene.
{
  const invitationScenes = new Set();
  const firstTurnAt = new Map(); // scene_id -> first turn.committed event id
  const endedScenes = new Set();
  const sceneCacheContexts = new Set(); // context_id of scene-origin lines
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'scene.started' && payload.invitation !== undefined) {
      invitationScenes.add(payload.scene_id);
    }
    if (event.type === 'turn.committed' && !firstTurnAt.has(payload.scene_id)) {
      firstTurnAt.set(payload.scene_id, event.id);
    }
    if (event.type === 'scene.ended') endedScenes.add(payload.scene_id);
    if (event.type === 'cache.appended' && payload.origin === 'scene') {
      sceneCacheContexts.add(payload.context_id);
    }
  }
  for (const event of events) {
    if (event.type !== 'scene.expired') continue;
    const payload = JSON.parse(event.payload);
    if (!invitationScenes.has(payload.scene_id)) {
      failures.push(
        `scene.expired ${payload.scene_id}: its scene.started carries no invitation`,
      );
    }
    const enteredAt = firstTurnAt.get(payload.scene_id);
    if (enteredAt !== undefined && enteredAt < event.id) {
      failures.push(
        `scene.expired ${payload.scene_id}: the user had entered (turn.committed ${enteredAt})`,
      );
    }
    if (endedScenes.has(payload.scene_id)) {
      failures.push(
        `scene.expired ${payload.scene_id}: coexists with a scene.ended`,
      );
    }
    if (!sceneCacheContexts.has(payload.scene_id)) {
      failures.push(
        `scene.expired ${payload.scene_id}: missing its absence cache entry (torn transaction)`,
      );
    }
  }
}

// 4k. Feed natural keys + atomicity (M6 part 5, Rev 4 §12): one post per
//     (world, occurrence_iso); one reaction decision per (post, character);
//     one answer per user reply (in_reply_to); every reaction/reply names a
//     post that exists (they are enqueued/committed atomically WITH it).
{
  const postKeys = new Set();
  const postIds = new Set();
  const reactionKeys = new Set();
  const answerKeys = new Set();
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'social.post_committed') {
      const key = `${event.world_id}:${payload.occurrence_iso}`;
      if (postKeys.has(key)) {
        failures.push(
          `social.post_committed ${payload.occurrence_iso}: duplicate post for the occurrence (natural key broken)`,
        );
      }
      postKeys.add(key);
      postIds.add(payload.post_id);
    }
  }
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'social.reaction_committed') {
      const key = `${payload.post_id}:${payload.character_id}`;
      if (reactionKeys.has(key)) {
        failures.push(
          `social.reaction_committed ${key}: duplicate reaction decision (natural key broken)`,
        );
      }
      reactionKeys.add(key);
      if (!postIds.has(payload.post_id)) {
        failures.push(
          `social.reaction_committed ${key}: names post ${payload.post_id} that is not in the log`,
        );
      }
      if (payload.kind === 'comment' && payload.body === undefined) {
        failures.push(
          `social.reaction_committed ${key}: a comment without a body passed the gate`,
        );
      }
      if (payload.kind === 'like' && payload.body !== undefined) {
        failures.push(
          `social.reaction_committed ${key}: a like carries a body`,
        );
      }
    }
    if (event.type === 'social.reply_answered') {
      if (answerKeys.has(payload.in_reply_to)) {
        failures.push(
          `social.reply_answered ${payload.reply_id}: duplicate answer for user reply ${payload.in_reply_to}`,
        );
      }
      answerKeys.add(payload.in_reply_to);
      if (!postIds.has(payload.post_id)) {
        failures.push(
          `social.reply_answered ${payload.reply_id}: names post ${payload.post_id} that is not in the log`,
        );
      }
    }
    if (event.type === 'social.reply_posted' && !postIds.has(payload.post_id)) {
      failures.push(
        `social.reply_posted ${payload.reply_id}: names post ${payload.post_id} that is not in the log`,
      );
    }
  }
}

// 4h. Chat-end atomicity (M6 part 2, Rev 4 §8): a chat.ended commits in ONE
//     transaction with its reflect_chat job — the event without the row is a
//     torn transaction. M6 part 4: a chat.group_ended commits with exactly
//     ONE reflect_chat job PER MEMBER (keys carry the character id).
for (const event of events) {
  if (event.type === 'chat.ended') {
    const payload = JSON.parse(event.payload);
    const key = `reflect_chat:${payload.conversation_id}:${payload.range_end_id}`;
    if (jobKeyExists.get(key).n !== 1) {
      failures.push(
        `chat.ended ${payload.conversation_id}: missing job ${key} (torn transaction)`,
      );
    }
  }
  if (event.type === 'chat.group_ended') {
    const payload = JSON.parse(event.payload);
    for (const memberId of payload.member_ids) {
      const key = `reflect_chat:${payload.conversation_id}:${memberId}:${payload.range_end_id}`;
      if (jobKeyExists.get(key).n !== 1) {
        failures.push(
          `chat.group_ended ${payload.conversation_id}: missing member job ${key} (torn transaction)`,
        );
      }
    }
  }
}

// 4g. Create-tool atomicity (M6 part 1, Rev 4 §6): a sublocation.stub_created
//     commits in ONE transaction with its backdrop paint job — and, when
//     parentless, its eager materialize job. The event without the rows is a
//     torn transaction.
for (const event of events) {
  if (event.type !== 'sublocation.stub_created') continue;
  const payload = JSON.parse(event.payload);
  const backdropKey = `painter:backdrop:${payload.sublocation_id}:initial`;
  if (jobKeyExists.get(backdropKey).n !== 1) {
    failures.push(
      `sublocation.stub_created ${payload.sublocation_id}: missing job ${backdropKey}`,
    );
  }
  if (payload.parent_id === undefined) {
    const materializeKey = `materialize:stub:${payload.sublocation_id}`;
    if (jobKeyExists.get(materializeKey).n !== 1) {
      failures.push(
        `parentless stub ${payload.sublocation_id}: missing job ${materializeKey}`,
      );
    }
  }
}

// 4f. Update pointer discipline (M3 part 2, Guide B12): if a `current`
//     pointer exists it must name a COMPLETE version directory — the flip is
//     rename-then-pointer, so a torn state is a violation. vNext leftovers
//     are legal here (startup deletes them; we run pre-startup).
const versionsDir = process.argv[4] ?? process.env.WELTARI_VERSIONS_DIR;
if (versionsDir && existsSync(join(versionsDir, 'current'))) {
  const pointer = readFileSync(join(versionsDir, 'current'), 'utf8').trim();
  if (pointer === '' || !existsSync(join(versionsDir, pointer))) {
    failures.push(
      `update pointer names "${pointer}" but versions/${pointer} does not exist (torn flip)`,
    );
  }
}

// 4d. World clock is monotonic per world (M2): each skip starts exactly where
//     the previous one ended.
const clockByWorld = new Map();
const eventWorlds = db
  .prepare('SELECT id, world_id, type, payload FROM events ORDER BY id')
  .all();
for (const event of eventWorlds) {
  if (event.type !== 'world.time_advanced') continue;
  const payload = JSON.parse(event.payload);
  const previous = clockByWorld.get(event.world_id);
  if (previous !== undefined && payload.from !== previous) {
    failures.push(
      `world clock gap in ${event.world_id}: skip starts at ${payload.from}, previous ended ${previous}`,
    );
  }
  if (!(payload.to > payload.from)) {
    failures.push(`world clock not monotonic at event ${event.id}`);
  }
  clockByWorld.set(event.world_id, payload.to);
}

// 4e. Zero corrupted images (M2 criterion a): every painter.completed names a
//     file whose bytes match its recorded sha256 — composite-on-success proven.
const painterEvents = events.filter((e) => e.type === 'painter.completed');
if (painterEvents.length > 0 && !imagesDir) {
  failures.push(
    `${painterEvents.length} painter.completed event(s) but no images dir given — cannot hash-verify`,
  );
}
if (imagesDir) {
  for (const event of painterEvents) {
    const payload = JSON.parse(event.payload);
    const filePath = join(imagesDir, payload.path);
    if (!existsSync(filePath)) {
      failures.push(
        `painter.completed ${payload.job_key}: file missing (${payload.path})`,
      );
      continue;
    }
    const hash = createHash('sha256')
      .update(readFileSync(filePath))
      .digest('hex');
    if (hash !== payload.sha256) {
      failures.push(
        `painter.completed ${payload.job_key}: hash mismatch — image corrupted`,
      );
    }
  }
}

// 4l. The memory store (M7 part 1, Rev 4 §11): delta sets are capped and
//     atomic with their reflection (a delta without its committed reflection
//     is a torn transaction; more than 3 per reflection escaped the gate);
//     compaction records are exactly-once per range (the harness never
//     repairs); the FTS Search Index exactly mirrors the delta events; a
//     CACHE watermark always points below itself.
{
  // Counted, not set-membership (M7 part 2 fix): a chat CONVERSATION closes
  // many ranges over its life and each range reflects once — the delta cap
  // is 3 PER REFLECTION, so the allowance scales with the committed
  // reflections for the context (delta events carry the conversation id,
  // not the range id).
  const reflectedScene = new Map();
  const reflectedChat = new Map();
  const deltaGroups = new Map();
  const compactionRanges = new Map();
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'reflection.committed') {
      const key = `${payload.character_id}|${payload.scene_id}`;
      reflectedScene.set(key, (reflectedScene.get(key) ?? 0) + 1);
    } else if (event.type === 'reflect_chat.committed') {
      const key = `${payload.character_id}|${payload.conversation_id}`;
      reflectedChat.set(key, (reflectedChat.get(key) ?? 0) + 1);
    } else if (event.type === 'memory.delta_committed') {
      const key = `${payload.character_id}|${payload.origin}|${payload.context_id}`;
      deltaGroups.set(key, (deltaGroups.get(key) ?? 0) + 1);
    } else if (event.type === 'memory.compacted') {
      const key = `${payload.character_id}|${payload.up_to_id}`;
      compactionRanges.set(key, (compactionRanges.get(key) ?? 0) + 1);
      if (payload.up_to_id >= event.id) {
        failures.push(
          `memory.compacted ${key}: up_to_id ${payload.up_to_id} is not below the record's own id ${event.id}`,
        );
      }
    } else if (event.type === 'cache.pruned') {
      if (payload.watermark_id >= event.id) {
        failures.push(
          `cache.pruned for ${payload.character_id}: watermark ${payload.watermark_id} is not below the record's own id ${event.id}`,
        );
      }
    }
  }
  for (const [key, count] of deltaGroups) {
    const [characterId, origin, contextId] = key.split('|');
    const reflections =
      origin === 'scene'
        ? (reflectedScene.get(`${characterId}|${contextId}`) ?? 0)
        : (reflectedChat.get(`${characterId}|${contextId}`) ?? 0);
    if (reflections === 0) {
      failures.push(
        `memory deltas for ${key}: no committed reflection for the context (torn transaction)`,
      );
    } else if (count > 3 * reflections) {
      failures.push(
        `memory deltas for ${key}: ${count} committed across ${reflections} reflections — the 3-per-reflection cap escaped the gate`,
      );
    }
  }
  for (const [key, count] of compactionRanges) {
    if (count > 1) {
      failures.push(
        `memory.compacted ${key}: ${count} records for one range (duplicate — the harness never repairs)`,
      );
    }
  }
  // The Search Index is a projection of the delta events — offline they must
  // mirror exactly (the add rides the append's transaction; boot rebuilds).
  const deltaEventIds = events
    .filter((e) => e.type === 'memory.delta_committed')
    .map((e) => e.id)
    .sort((a, b) => a - b);
  const ftsIds = db
    .prepare('SELECT event_id FROM memory_delta_fts ORDER BY event_id')
    .all()
    .map((r) => Number(r.event_id));
  if (JSON.stringify(ftsIds) !== JSON.stringify(deltaEventIds)) {
    failures.push(
      `memory Search Index out of sync: ${ftsIds.length} FTS rows vs ${deltaEventIds.length} delta events`,
    );
  }
}

// 4m. The Proposal pipeline + GM surface (M7 part 2, Rev 4 §16/§9): every
//     proposal resolves at most once and only if it exists; a REJECTED
//     proposal has ZERO domain rows carrying its id (I8); an APPROVED
//     create_place/seed_world proposal's applied rows exist and match the
//     diff exactly (atomic apply); at most one world.seeded per world; at
//     most one gateway binding per (connector, conversation) pair.
{
  const proposals = new Map();
  const resolutions = new Map();
  const appliedByProposal = new Map();
  const seededWorlds = new Map();
  const bindings = new Map();
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'proposal.submitted') {
      proposals.set(payload.proposal_id, payload);
    } else if (event.type === 'proposal.resolved') {
      resolutions.set(
        payload.proposal_id,
        (resolutions.get(payload.proposal_id) ?? []).concat(payload.resolution),
      );
    } else if (
      (event.type === 'sublocation.materialized' ||
        event.type === 'subwiki.edited' ||
        event.type === 'character.created' ||
        event.type === 'object.created' ||
        event.type === 'world.seeded') &&
      payload.proposal_id !== undefined
    ) {
      const applied = appliedByProposal.get(payload.proposal_id) ?? [];
      applied.push(event.type);
      appliedByProposal.set(payload.proposal_id, applied);
    }
    if (event.type === 'world.seeded') {
      seededWorlds.set(
        event.world_id,
        (seededWorlds.get(event.world_id) ?? 0) + 1,
      );
    }
    if (event.type === 'gateway.binding_established') {
      const key = `${payload.connector_id}|${payload.conversation_id}`;
      bindings.set(key, (bindings.get(key) ?? 0) + 1);
    }
  }
  for (const [proposalId, list] of resolutions) {
    if (!proposals.has(proposalId)) {
      failures.push(`proposal.resolved ${proposalId}: no such proposal`);
      continue;
    }
    if (list.length > 1) {
      failures.push(
        `proposal ${proposalId} resolved ${list.length} times (once ever)`,
      );
    }
    const applied = appliedByProposal.get(proposalId) ?? [];
    const resolution = list[0];
    if (resolution === 'rejected' && applied.length > 0) {
      failures.push(
        `REJECTED proposal ${proposalId} has ${applied.length} applied rows (I8: zero)`,
      );
    }
    if (resolution === 'approved') {
      const payload = proposals.get(proposalId);
      const rows = (type) => applied.filter((t) => t === type).length;
      if (payload.action === 'create_place') {
        if (rows('sublocation.materialized') !== 1) {
          failures.push(
            `approved create_place ${proposalId}: ${rows('sublocation.materialized')} materialized rows (want 1)`,
          );
        }
      } else if (payload.action === 'create_object') {
        if (rows('object.created') !== 1) {
          failures.push(
            `approved create_object ${proposalId}: ${rows('object.created')} object rows (want 1)`,
          );
        }
      } else if (payload.action === 'seed_world') {
        if (rows('sublocation.materialized') !== payload.diff.places.length) {
          failures.push(
            `approved seed_world ${proposalId}: ${rows('sublocation.materialized')} materialized rows (want ${payload.diff.places.length})`,
          );
        }
        if (rows('character.created') !== payload.diff.characters.length) {
          failures.push(
            `approved seed_world ${proposalId}: ${rows('character.created')} character rows (want ${payload.diff.characters.length})`,
          );
        }
        if (rows('world.seeded') !== 1) {
          failures.push(
            `approved seed_world ${proposalId}: ${rows('world.seeded')} world.seeded (want 1)`,
          );
        }
      }
    }
  }
  // Applied rows may never exist WITHOUT an approving resolution.
  for (const [proposalId, applied] of appliedByProposal) {
    const list = resolutions.get(proposalId) ?? [];
    if (!list.includes('approved')) {
      failures.push(
        `${applied.length} applied rows for ${proposalId} without an approval (torn apply)`,
      );
    }
  }
  for (const [worldId, count] of seededWorlds) {
    if (count > 1)
      failures.push(`world ${worldId} seeded ${count} times (once ever)`);
  }
  for (const [key, count] of bindings) {
    if (count > 1) {
      failures.push(
        `gateway binding ${key} established ${count} times (once per binding)`,
      );
    }
  }
  // Profiling (Rev 4 §9 Job 2): each analysis context commits at most one
  // profile.updated; its side-store rows exist unless a LATER
  // profile.deleted erased the actor's store (the sanctioned mutation).
  const profileRows = db.prepare(
    'SELECT COUNT(*) AS n FROM user_profile WHERE actor_id = ? AND context_id = ?',
  );
  const updatedByContext = new Map();
  const deletedAfter = new Map();
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'profile.updated') {
      const key = `${payload.user_actor_id}|${payload.context_id}`;
      updatedByContext.set(key, (updatedByContext.get(key) ?? 0) + 1);
    } else if (event.type === 'profile.deleted') {
      deletedAfter.set(payload.user_actor_id, event.id);
    }
  }
  for (const [key, count] of updatedByContext) {
    if (count > 1) {
      failures.push(`profile.updated ${key}: ${count} passes for one context`);
    }
    const [actorId, contextId] = key.split('|');
    const rows = profileRows.get(actorId, contextId).n;
    if (rows === 0 && !deletedAfter.has(actorId)) {
      failures.push(
        `profile.updated ${key}: zero side-store rows and no profile.deleted (torn transaction)`,
      );
    }
  }
}

// 4n. Objects (M7 part 3, Rev 4 §7): the objects table mirrors the fold of
//     the object.* events exactly (the row rides the append's transaction;
//     boot rebuilds); every object event references an object alive at that
//     point (created once, nothing after swept); (name, holder) stays unique
//     among live rows per world; a swept object was a legal stray — payload-
//     less, scene-created, never touched outside its creating scene, and its
//     creating scene had ENDED before the tombstone.
{
  const nameKey = (name) => name.trim().toLowerCase().replace(/\s+/g, ' ');
  const fold = new Map(); // object_id -> live folded row
  const sceneEndIds = new Map(); // scene_id -> event id of its end
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'scene.ended' || event.type === 'scene.expired') {
      sceneEndIds.set(payload.scene_id, event.id);
      continue;
    }
    if (
      event.type !== 'object.created' &&
      event.type !== 'object.payload_written' &&
      event.type !== 'object.moved' &&
      event.type !== 'object.swept'
    ) {
      continue;
    }
    const id = payload.object_id;
    const row = fold.get(id);
    if (event.type === 'object.created') {
      if (row !== undefined) {
        failures.push(`object ${id} created twice (event ${event.id})`);
        continue;
      }
      fold.set(id, {
        world_id: event.world_id,
        name: payload.name,
        holder: payload.holder_sublocation_id,
        payload: payload.object_payload ?? null,
        createdScene: payload.scene_id ?? null,
        touchedOutsideCreatingScene: false,
      });
      continue;
    }
    if (row === undefined) {
      failures.push(
        `${event.type} (event ${event.id}) references object ${id} that is not alive`,
      );
      continue;
    }
    if (event.type === 'object.payload_written') {
      row.payload = payload.object_payload;
      if (payload.scene_id !== row.createdScene)
        row.touchedOutsideCreatingScene = true;
    } else if (event.type === 'object.moved') {
      row.holder = payload.to_sublocation_id;
      if (payload.scene_id !== row.createdScene)
        row.touchedOutsideCreatingScene = true;
    } else {
      // The tombstone: legal only for a true stray of an ended scene.
      if (row.payload !== null) {
        failures.push(
          `object ${id} swept WITH a payload (carriers are exempt)`,
        );
      }
      if (row.createdScene === null) {
        failures.push(
          `object ${id} swept without a creating scene (GM-authored objects are exempt)`,
        );
      } else {
        const endId = sceneEndIds.get(row.createdScene);
        if (endId === undefined || endId > event.id) {
          failures.push(
            `object ${id} swept before its creating scene ${row.createdScene} ended`,
          );
        }
      }
      if (row.touchedOutsideCreatingScene) {
        failures.push(
          `object ${id} swept although a later scene touched it (not a stray)`,
        );
      }
      fold.delete(id);
    }
  }
  // Live-row uniqueness per (world, holder, name key).
  const seenKeys = new Map();
  for (const [id, row] of fold) {
    const key = `${row.world_id}|${row.holder}|${nameKey(row.name)}`;
    const prior = seenKeys.get(key);
    if (prior !== undefined) {
      failures.push(`objects ${prior} and ${id} share (name, holder) ${key}`);
    }
    seenKeys.set(key, id);
  }
  // The table mirrors the fold exactly.
  const tableRows = db
    .prepare(
      'SELECT object_id, world_id, name, holder_sublocation_id, payload FROM objects',
    )
    .all();
  if (tableRows.length !== fold.size) {
    failures.push(
      `objects table has ${tableRows.length} rows, the event fold ${fold.size}`,
    );
  }
  for (const row of tableRows) {
    const folded = fold.get(row.object_id);
    if (folded === undefined) {
      failures.push(`objects table row ${row.object_id} has no live fold`);
      continue;
    }
    if (
      folded.name !== row.name ||
      folded.holder !== row.holder_sublocation_id ||
      (folded.payload ?? null) !== row.payload
    ) {
      failures.push(
        `objects table row ${row.object_id} diverges from its event fold`,
      );
    }
  }
}

// 4o. Markers (M7 part 4, Rev 4 §14/§17): the markers table mirrors the fold
//     of the marker.* events exactly; state walks dropped → instantiated |
//     expired only; the live set never exceeds the ceiling (5) at any drop;
//     the expiry stamp is exactly dropped_at + ttl; a marker is never
//     dropped born-expired (scheduled + ttl behind the world clock at drop);
//     every instantiation names a scene.started that exists; every expiry
//     was judged at or after the marker's deadline.
{
  const MARKER_MAX = 5;
  const fold = new Map(); // marker_id -> { world, state, sublocation, expires, scene }
  const liveCount = new Map(); // world_id -> live markers
  const clockNow = new Map(); // world_id -> latest fictional time at this point
  const sceneStartIds = new Map(); // scene_id -> event id
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'world.time_advanced') {
      clockNow.set(event.world_id, payload.to);
      continue;
    }
    if (event.type === 'scene.started') {
      sceneStartIds.set(payload.scene_id, event.id);
      continue;
    }
    if (
      event.type !== 'marker.dropped' &&
      event.type !== 'marker.instantiated' &&
      event.type !== 'marker.expired'
    ) {
      continue;
    }
    const id = payload.marker_id;
    const row = fold.get(id);
    if (event.type === 'marker.dropped') {
      if (row !== undefined) {
        failures.push(`marker ${id} dropped twice (event ${event.id})`);
        continue;
      }
      const live = (liveCount.get(event.world_id) ?? 0) + 1;
      liveCount.set(event.world_id, live);
      if (live > MARKER_MAX) {
        failures.push(
          `marker ${id} (event ${event.id}) pushed world ${event.world_id} to ${live} live markers (ceiling ${MARKER_MAX})`,
        );
      }
      const expected = new Date(
        Date.parse(payload.dropped_at_game_time) +
          payload.ttl_game_minutes * 60000,
      ).toISOString();
      if (payload.expires_at_game_time !== expected) {
        failures.push(
          `marker ${id} expiry stamp ${payload.expires_at_game_time} != dropped_at + ttl (${expected})`,
        );
      }
      const clock = clockNow.get(event.world_id);
      if (clock !== undefined && payload.expires_at_game_time <= clock) {
        failures.push(
          `marker ${id} (event ${event.id}) dropped born-expired: expires ${payload.expires_at_game_time} <= clock ${clock}`,
        );
      }
      fold.set(id, {
        world: event.world_id,
        state: 'dropped',
        sublocation: payload.sublocation_id,
        expires: payload.expires_at_game_time,
        scene: null,
      });
      continue;
    }
    if (row === undefined || row.state !== 'dropped') {
      failures.push(
        `${event.type} (event ${event.id}) references marker ${id} that is not live`,
      );
      continue;
    }
    liveCount.set(row.world, (liveCount.get(row.world) ?? 1) - 1);
    if (event.type === 'marker.instantiated') {
      row.state = 'instantiated';
      row.scene = payload.scene_id;
    } else {
      row.state = 'expired';
      if (payload.game_time < row.expires) {
        failures.push(
          `marker ${id} expired at ${payload.game_time}, before its deadline ${row.expires}`,
        );
      }
    }
  }
  // Every instantiation opened its ONE scene (the same-transaction pair).
  for (const [id, row] of fold) {
    if (row.state === 'instantiated' && !sceneStartIds.has(row.scene)) {
      failures.push(
        `marker ${id} instantiated into scene ${row.scene} but no scene.started exists`,
      );
    }
  }
  // The table mirrors the fold exactly (terminal rows stay, by design).
  const tableRows = db
    .prepare(
      'SELECT marker_id, world_id, state, sublocation_id, expires_at_game_time, instantiated_scene_id FROM markers',
    )
    .all();
  if (tableRows.length !== fold.size) {
    failures.push(
      `markers table has ${tableRows.length} rows, the event fold ${fold.size}`,
    );
  }
  for (const row of tableRows) {
    const folded = fold.get(row.marker_id);
    if (folded === undefined) {
      failures.push(`markers table row ${row.marker_id} has no fold`);
      continue;
    }
    if (
      folded.state !== row.state ||
      folded.sublocation !== row.sublocation_id ||
      folded.expires !== row.expires_at_game_time ||
      (folded.scene ?? null) !== row.instantiated_scene_id
    ) {
      failures.push(
        `markers table row ${row.marker_id} diverges from its event fold`,
      );
    }
  }
}

// 4p. CRON world movement (M7 part 4, Rev 4 §14): every
//     character.location_changed carries the world-cron system actor, lands
//     on a sublocation known at that point (materialized-only anchoring —
//     stubs never receive CRON traffic), never moves a character who was in
//     an open scene, and chains exactly (from = the character's previous
//     folded location; absent only on the first move).
{
  const knownAnchors = new Map(); // world_id -> Set of materialized ids
  const stubOnly = new Map(); // world_id -> Set of stub-only ids
  const openScenes = new Map(); // world_id|character_id -> Set of scene ids
  const location = new Map(); // world_id|character_id -> sublocation_id
  const anchorSet = (worldId) => {
    let set = knownAnchors.get(worldId);
    if (set === undefined) {
      set = new Set();
      knownAnchors.set(worldId, set);
    }
    return set;
  };
  const stubSet = (worldId) => {
    let set = stubOnly.get(worldId);
    if (set === undefined) {
      set = new Set();
      stubOnly.set(worldId, set);
    }
    return set;
  };
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (
      event.type === 'sublocation.materialized' ||
      event.type === 'sublocation.created'
    ) {
      anchorSet(event.world_id).add(payload.sublocation_id);
      stubSet(event.world_id).delete(payload.sublocation_id);
    } else if (event.type === 'sublocation.stub_created') {
      stubSet(event.world_id).add(payload.sublocation_id);
    } else if (
      event.type === 'map_click.resolved' &&
      payload.outcome === 'created' &&
      payload.sublocation_id !== undefined
    ) {
      anchorSet(event.world_id).add(payload.sublocation_id);
      stubSet(event.world_id).delete(payload.sublocation_id);
    } else if (event.type === 'character.joined') {
      const key = `${event.world_id}|${payload.character_id}`;
      const scenes = openScenes.get(key) ?? new Set();
      scenes.add(payload.scene_id);
      openScenes.set(key, scenes);
    } else if (event.type === 'scene.ended' || event.type === 'scene.expired') {
      for (const scenes of openScenes.values()) scenes.delete(payload.scene_id);
    } else if (event.type === 'character.location_changed') {
      if (event.actor_id !== 'system:world_cron') {
        failures.push(
          `location change (event ${event.id}) from actor ${event.actor_id} — V1's only mover is system:world_cron`,
        );
      }
      const target = payload.to_sublocation_id;
      if (
        !anchorSet(event.world_id).has(target) ||
        stubSet(event.world_id).has(target)
      ) {
        failures.push(
          `movement (event ${event.id}) landed ${payload.character_id} on ${target}, not a materialized sublocation at that point`,
        );
      }
      const key = `${event.world_id}|${payload.character_id}`;
      const scenes = openScenes.get(key);
      if (scenes !== undefined && scenes.size > 0) {
        failures.push(
          `movement (event ${event.id}) moved ${payload.character_id} while in open scene(s) ${[...scenes].join(', ')}`,
        );
      }
      const previous = location.get(key);
      if ((payload.from_sublocation_id ?? undefined) !== previous) {
        failures.push(
          `movement (event ${event.id}) from ${payload.from_sublocation_id ?? '(none)'} breaks the chain (previous ${previous ?? '(none)'})`,
        );
      }
      location.set(key, target);
    }
  }
}

// 4q. The GM proposal UX contract (0.20.0, Rev 4 §9/§16): the durable
//     tool-result turn is SINGLE — at most ONE GM follow-up message per
//     resolution (message_id gm-followup-<proposal_id>) and per discuss
//     signal (gm-discuss-<proposal_id>); every follow-up is a GM character
//     line whose outcome exists and PRECEDES it in the log (a missing
//     follow-up is legal mid-kill — the boot sweep heals it; a duplicate or
//     an orphan never is); a proposal is discussed at most once, only while
//     it existed unresolved.
{
  const submittedAt = new Map(); // proposal_id -> submit event id
  const resolvedAt = new Map(); // proposal_id -> first resolution event id
  const discussedAt = new Map(); // proposal_id -> [discuss event ids]
  const followups = new Map(); // message_id -> [event ids]
  for (const event of events) {
    const payload = JSON.parse(event.payload);
    if (event.type === 'proposal.submitted') {
      submittedAt.set(payload.proposal_id, event.id);
    } else if (event.type === 'proposal.resolved') {
      if (!resolvedAt.has(payload.proposal_id)) {
        resolvedAt.set(payload.proposal_id, event.id);
      }
    } else if (event.type === 'proposal.discussed') {
      discussedAt.set(
        payload.proposal_id,
        (discussedAt.get(payload.proposal_id) ?? []).concat(event.id),
      );
    } else if (
      event.type === 'chat.message_committed' &&
      typeof payload.message_id === 'string' &&
      (payload.message_id.startsWith('gm-followup-') ||
        payload.message_id.startsWith('gm-discuss-'))
    ) {
      followups.set(
        payload.message_id,
        (followups.get(payload.message_id) ?? []).concat(event.id),
      );
      if (event.actor_id !== 'char:gm' || payload.sender !== 'character') {
        failures.push(
          `follow-up ${payload.message_id} (event ${event.id}) is not a GM character line`,
        );
      }
    }
  }
  for (const [proposalId, list] of discussedAt) {
    if (!submittedAt.has(proposalId)) {
      failures.push(`proposal.discussed ${proposalId}: no such proposal`);
    }
    if (list.length > 1) {
      failures.push(
        `proposal ${proposalId} discussed ${list.length} times (once while pending)`,
      );
    }
    const resolved = resolvedAt.get(proposalId);
    if (resolved !== undefined && list.some((id) => id > resolved)) {
      failures.push(`proposal ${proposalId} discussed after its resolution`);
    }
  }
  for (const [messageId, list] of followups) {
    if (list.length > 1) {
      failures.push(
        `follow-up ${messageId} committed ${list.length} times (the natural key is single)`,
      );
      continue;
    }
    const discuss = messageId.startsWith('gm-discuss-');
    const proposalId = messageId.slice(
      discuss ? 'gm-discuss-'.length : 'gm-followup-'.length,
    );
    const outcomeAt = discuss
      ? (discussedAt.get(proposalId) ?? [])[0]
      : resolvedAt.get(proposalId);
    if (outcomeAt === undefined) {
      failures.push(
        `follow-up ${messageId}: no ${discuss ? 'discuss signal' : 'resolution'} exists for ${proposalId}`,
      );
    } else if (list[0] < outcomeAt) {
      failures.push(
        `follow-up ${messageId} (event ${list[0]}) precedes its outcome (event ${outcomeAt})`,
      );
    }
  }
}

// 5. Ledger rows are in legal states with legal shapes
const badStates = db
  .prepare(
    `SELECT id, state FROM ledger_jobs
     WHERE state NOT IN ('pending','running','committed','failed','parked')`,
  )
  .all();
for (const row of badStates)
  failures.push(`job ${row.id} has illegal state ${row.state}`);
const runningWithoutLease = db
  .prepare(
    `SELECT id FROM ledger_jobs WHERE state='running' AND lease_until IS NULL`,
  )
  .all();
for (const row of runningWithoutLease)
  failures.push(`running job ${row.id} has no lease`);

db.close();

if (failures.length > 0) {
  console.error(`CONSISTENCY FAILURES (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `consistency ok: ${events.length} events, ids strictly increasing, envelopes clean`,
);
