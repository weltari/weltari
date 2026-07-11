// The Proposal pipeline (M7 part 2, Rev 4 §16): one uniform consent flow —
// an agent emits Proposal{action, diff, rationale, proposer, approvers[]} →
// the frontend renders the diff → approval applies THROUGH THE ENGINE → both
// are logged events. Submit writes nothing but the proposal record; the diff
// is a complete deterministic description of the change, so the approving
// command applies it atomically with proposal.resolved — no LLM sits between
// consent and application (B6: LLM output is never directly durable; here it
// becomes durable only through the user's own approval). Reject writes the
// resolved event alone: zero domain rows (I8). The GM is the first proposer;
// nothing here knows who proposes.
import { randomUUID } from 'node:crypto';
import {
  ProposalSubmittedEventSchema,
  type ProposalCharacterDiff,
  type ProposalPlaceDiff,
  type ResolveProposalCommand,
  type WeltariEvent,
} from '@weltari/protocol';
import { validateAt } from '../boundary/validate.js';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import { backdropPaintJob } from '../painter/commands.js';
import type { NewEvent } from '../storage/repositories/event-log.js';
import type { NewLedgerJob } from '../storage/repositories/ledger.js';
import type { Storage } from '../storage/db.js';
import type { CharacterProfile } from './context-assembler.js';
import { characterProfilesOf } from './characters.js';
import type { EventSink } from './event-sink.js';
import type { FaultPointHook } from './fault-points.js';
import { slugifyName } from './scene-tools.js';
import {
  knownSublocations,
  occupiedSquaresOf,
  solveFrontierFrom,
  squareCenter,
  squareKey,
} from './sublocations.js';

export type ProposalPayload = Extract<
  WeltariEvent,
  { type: 'proposal.submitted' }
>['payload'];

export interface PendingProposal {
  /** Log id of the proposal.submitted event. */
  event_id: number;
  ts: string;
  payload: ProposalPayload;
}

interface ProposalRecord extends PendingProposal {
  resolution?: 'approved' | 'rejected';
}

/** The full proposal fold for a world: every submit, with its resolution
 * when one landed. */
function proposalRecordsOf(
  storage: Storage,
  worldId: string,
): Map<string, ProposalRecord> {
  const records = new Map<string, ProposalRecord>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'proposal.submitted') {
      records.set(event.payload.proposal_id, {
        event_id: event.id,
        ts: event.ts,
        payload: event.payload,
      });
    } else if (event.type === 'proposal.resolved') {
      const record = records.get(event.payload.proposal_id);
      if (record !== undefined) record.resolution = event.payload.resolution;
    }
  }
  return records;
}

/** The pending-proposals projection (Rev 4 §16) — submit order. */
export function pendingProposalsOf(
  storage: Storage,
  worldId: string,
): PendingProposal[] {
  return [...proposalRecordsOf(storage, worldId).values()].filter(
    (r) => r.resolution === undefined,
  );
}

/** True once a world.seeded event exists — cold boot's terminal state. */
export function worldSeeded(storage: Storage, worldId: string): boolean {
  return storage.eventLog
    .readSince(0, 100000)
    .some((e) => e.world_id === worldId && e.type === 'world.seeded');
}

/** Deterministic ids per name — a retried submit collides instead of
 * twinning, and gate 2 rejects the collision. */
export function sublocationIdForPlace(name: string): string {
  return `subloc:gm-${slugifyName(name)}`;
}
export function characterIdForName(name: string): string {
  return `char:${slugifyName(name)}`;
}

export interface ProposalEngineOptions {
  storage: Storage;
  sink: EventSink;
  logger: Logger;
  /** The world's seed (fixture/config) profiles — the character-id dedup
   * base; created characters fold in per call. */
  seedProfiles: readonly CharacterProfile[];
  faultPoint?: FaultPointHook;
}

export interface SubmitProposalRequest {
  world_id: string;
  /** The proposing agent's actor id (becomes both the envelope actor_id and
   * the §16 `proposer` field). */
  proposer: string;
  /** V1: the single user actor. */
  approvers: readonly string[];
  action: ProposalPayload['action'];
  diff: unknown;
  rationale: string;
}

export interface ProposalEngine {
  /**
   * The DRY-RUN half of submit (M7 part 2): shape the request through the
   * wire union + run gate 2, returning the payload WITHOUT appending — the
   * GM engine commits its reply and the prepared proposals in one
   * transaction (the card can never exist without the line that offered it).
   */
  prepare(request: SubmitProposalRequest): Result<{ payload: ProposalPayload }>;
  /** Gate-2 check + append proposal.submitted. The diff arrives gate-1
   * validated (the caller parsed the tool call); this seam re-shapes it into
   * the typed payload and refuses references the world state disowns. */
  submit(request: SubmitProposalRequest): Result<{ proposalId: string }>;
  /** The approver's decision. Approve applies the diff atomically with
   * proposal.resolved; reject appends the resolved event alone. */
  resolve(
    command: ResolveProposalCommand,
  ): Promise<Result<{ applied: number }>>;
  pending(worldId: string): PendingProposal[];
}

/** What one approved diff appends and enqueues — assembled BEFORE the
 * transaction, applied inside it. */
interface ApplyPlan {
  events: NewEvent[];
  jobs: NewLedgerJob[];
}

export function createProposalEngine(
  options: ProposalEngineOptions,
): ProposalEngine {
  const { storage, sink, seedProfiles } = options;

  function profiles(worldId: string): CharacterProfile[] {
    return characterProfilesOf(storage, worldId, seedProfiles);
  }

  /** Gate 2 for a place: the deterministic id must be free. */
  function gatePlace(
    worldId: string,
    place: ProposalPlaceDiff,
  ): Result<undefined> {
    const id = sublocationIdForPlace(place.name);
    const known = knownSublocations(storage, worldId);
    const slug = slugifyName(place.name);
    const taken = known.some(
      (s) => s.sublocation_id === id || slugifyName(s.name) === slug,
    );
    return taken
      ? err(
          new OperationalError(
            'place_exists',
            `a sublocation named like "${place.name}" already exists`,
          ),
        )
      : ok(undefined);
  }

  /** Gate 2 for a character: the deterministic id must be free. */
  function gateCharacter(
    worldId: string,
    character: ProposalCharacterDiff,
  ): Result<undefined> {
    const id = characterIdForName(character.name);
    const taken = profiles(worldId).some((p) => p.character_id === id);
    return taken
      ? err(
          new OperationalError(
            'character_exists',
            `a character named like "${character.name}" already exists`,
          ),
        )
      : ok(undefined);
  }

  /** Gate 2 per action — run at submit AND re-run at apply (world state may
   * have moved while the card sat pending; B6's second gate holds twice). */
  function gate(worldId: string, payload: ProposalPayload): Result<undefined> {
    switch (payload.action) {
      case 'create_place':
        return gatePlace(worldId, payload.diff);
      case 'create_character':
        return gateCharacter(worldId, payload.diff);
      case 'edit_wiki': {
        const known = knownSublocations(storage, worldId).some(
          (s) => s.sublocation_id === payload.diff.sublocation_id,
        );
        return known
          ? ok(undefined)
          : err(
              new OperationalError(
                'unknown_sublocation',
                'no such sublocation',
              ),
            );
      }
      case 'seed_world': {
        if (worldSeeded(storage, worldId)) {
          return err(
            new OperationalError('already_seeded', 'this world is seeded'),
          );
        }
        const spaces = new Set(payload.diff.places.map((p) => p.space));
        if (!spaces.has('public') || !spaces.has('private')) {
          return err(
            new OperationalError(
              'seed_space_mix',
              'seeding needs at least one public and one private space (Rev 4 §9)',
            ),
          );
        }
        const placeSlugs = payload.diff.places.map((p) => slugifyName(p.name));
        const charSlugs = payload.diff.characters.map((c) =>
          slugifyName(c.name),
        );
        if (
          new Set(placeSlugs).size !== placeSlugs.length ||
          new Set(charSlugs).size !== charSlugs.length
        ) {
          return err(
            new OperationalError(
              'duplicate_names',
              'seed names must be unique',
            ),
          );
        }
        for (const place of payload.diff.places) {
          const gated = gatePlace(worldId, place);
          if (!gated.ok) return gated;
        }
        for (const character of payload.diff.characters) {
          const gated = gateCharacter(worldId, character);
          if (!gated.ok) return gated;
        }
        return ok(undefined);
      }
    }
  }

  /** One place → its materialized row (+ opening wiki entry + backdrop job).
   * Placement is code-owned (Rev 4 §14): the frontier solver picks the
   * square against `occupied`, which the caller extends per placed square so
   * a multi-place apply never stacks two places on one square. */
  function placePlan(
    worldId: string,
    actorId: string,
    proposalId: string,
    place: ProposalPlaceDiff,
    occupied: Set<string>,
  ): Result<ApplyPlan> {
    const square = solveFrontierFrom(occupied, { x: 0.5, y: 0.5 });
    if (square === undefined) {
      return err(new OperationalError('map_full', 'no free fog square left'));
    }
    occupied.add(squareKey(square));
    const sublocationId = sublocationIdForPlace(place.name);
    const events: NewEvent[] = [
      {
        world_id: worldId,
        actor_id: actorId,
        type: 'sublocation.materialized',
        payload: {
          sublocation_id: sublocationId,
          name: place.name,
          description: place.description,
          square,
          map_position: squareCenter(square),
          space: place.space,
          proposal_id: proposalId,
        },
      },
      ...(place.wiki_entry === undefined
        ? []
        : [
            {
              world_id: worldId,
              actor_id: actorId,
              type: 'subwiki.edited' as const,
              payload: {
                sublocation_id: sublocationId,
                entry: place.wiki_entry,
                proposal_id: proposalId,
              },
            },
          ]),
    ];
    return ok({
      events,
      jobs: [backdropPaintJob(worldId, sublocationId)],
    });
  }

  function characterPlan(
    worldId: string,
    actorId: string,
    proposalId: string,
    character: ProposalCharacterDiff,
  ): ApplyPlan {
    return {
      events: [
        {
          world_id: worldId,
          actor_id: actorId,
          type: 'character.created',
          payload: {
            character_id: characterIdForName(character.name),
            name: character.name,
            personality: character.personality,
            goals: character.goals,
            core: character.core,
            skills: character.skills,
            proposal_id: proposalId,
          },
        },
      ],
      jobs: [],
    };
  }

  /** The deterministic apply plan for an approved payload. The envelope
   * actor on applied rows is the PROPOSER (who authored the change); the
   * approval itself carries the approver's actor on proposal.resolved. */
  function applyPlan(
    worldId: string,
    payload: ProposalPayload,
  ): Result<ApplyPlan> {
    const actorId = payload.proposer;
    switch (payload.action) {
      case 'create_place':
        return placePlan(
          worldId,
          actorId,
          payload.proposal_id,
          payload.diff,
          occupiedSquaresOf(storage, worldId),
        );
      case 'create_character':
        return ok(
          characterPlan(worldId, actorId, payload.proposal_id, payload.diff),
        );
      case 'edit_wiki':
        return ok({
          events: [
            {
              world_id: worldId,
              actor_id: actorId,
              type: 'subwiki.edited',
              payload: {
                sublocation_id: payload.diff.sublocation_id,
                entry: payload.diff.entry,
                proposal_id: payload.proposal_id,
              },
            },
          ],
          jobs: [],
        });
      case 'seed_world': {
        const plan: ApplyPlan = { events: [], jobs: [] };
        const occupied = occupiedSquaresOf(storage, worldId);
        for (const place of payload.diff.places) {
          const placed = placePlan(
            worldId,
            actorId,
            payload.proposal_id,
            place,
            occupied,
          );
          if (!placed.ok) return placed;
          plan.events.push(...placed.value.events);
          plan.jobs.push(...placed.value.jobs);
        }
        for (const character of payload.diff.characters) {
          const characters = characterPlan(
            worldId,
            actorId,
            payload.proposal_id,
            character,
          );
          plan.events.push(...characters.events);
        }
        plan.events.push({
          world_id: worldId,
          actor_id: actorId,
          type: 'world.seeded',
          payload: {
            world_name: payload.diff.world_name,
            language: payload.diff.language,
            ...(payload.diff.chapter_seed === undefined
              ? {}
              : { chapter_seed: payload.diff.chapter_seed }),
            place_count: payload.diff.places.length,
            character_count: payload.diff.characters.length,
            proposal_id: payload.proposal_id,
          },
        });
        return ok(plan);
      }
    }
  }

  function prepare(
    request: SubmitProposalRequest,
  ): Result<{ payload: ProposalPayload }> {
    const proposalId = `prop-${randomUUID().slice(0, 8)}`;
    // Re-shape the gate-1-validated diff into the typed payload through
    // the wire schema itself — the one place the union's action↔diff
    // pairing is enforced (B5: our own format, strict; B3: via validateAt).
    const candidate: unknown = {
      proposal_id: proposalId,
      rationale: request.rationale,
      proposer: request.proposer,
      approvers: request.approvers,
      action: request.action,
      diff: request.diff,
    };
    const shaped = validateAt(
      'llm',
      'proposal:payload',
      ProposalSubmittedEventSchema.shape.payload,
      candidate,
      options.logger,
    );
    if (!shaped.ok) return shaped;
    const gated = gate(request.world_id, shaped.value);
    if (!gated.ok) return gated;
    return ok({ payload: shaped.value });
  }

  return {
    prepare,

    submit(request: SubmitProposalRequest): Result<{ proposalId: string }> {
      const prepared = prepare(request);
      if (!prepared.ok) return prepared;
      sink.append({
        world_id: request.world_id,
        actor_id: request.proposer,
        type: 'proposal.submitted',
        payload: prepared.value.payload,
      });
      return ok({ proposalId: prepared.value.payload.proposal_id });
    },

    async resolve(
      command: ResolveProposalCommand,
    ): Promise<Result<{ applied: number }>> {
      const records = proposalRecordsOf(storage, command.world_id);
      const record = records.get(command.proposal_id);
      if (record === undefined) {
        return err(
          new OperationalError('unknown_proposal', 'no such proposal'),
        );
      }
      if (record.resolution !== undefined) {
        return err(
          new OperationalError(
            'already_resolved',
            `this proposal was already ${record.resolution}`,
          ),
        );
      }
      if (!record.payload.approvers.includes(command.actor_id)) {
        return err(
          new OperationalError(
            'not_an_approver',
            'only a listed approver may resolve this proposal',
          ),
        );
      }
      const resolved: NewEvent = {
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'proposal.resolved',
        payload: {
          proposal_id: command.proposal_id,
          resolution: command.resolution,
        },
      };
      if (command.resolution === 'rejected') {
        // Zero domain rows (I8): the decision is the only durable trace.
        sink.append(resolved);
        return ok({ applied: 0 });
      }
      // Approve: gate 2 re-runs against CURRENT world state (the card may
      // have sat pending while the world moved), then the plan assembles.
      const gated = gate(command.world_id, record.payload);
      if (!gated.ok) return gated;
      const plan = applyPlan(command.world_id, record.payload);
      if (!plan.ok) return plan;
      // The kill window (I4): everything decided, nothing durable yet.
      await options.faultPoint?.('mid_proposal_apply');
      // Fused re-check, NO awaits from here to the append: an overlapped
      // resolve for the same proposal loses cleanly (the triad's third leg;
      // natural key = proposal_id via the resolved fold).
      const recheck = proposalRecordsOf(storage, command.world_id).get(
        command.proposal_id,
      );
      if (recheck === undefined || recheck.resolution !== undefined) {
        return err(
          new OperationalError('already_resolved', 'resolved concurrently'),
        );
      }
      sink.appendManyWithJobs(
        [resolved, ...plan.value.events],
        plan.value.jobs,
      );
      return ok({ applied: plan.value.events.length });
    },

    pending(worldId: string): PendingProposal[] {
      return pendingProposalsOf(storage, worldId);
    },
  };
}
