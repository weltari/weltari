// The protocol package is the language-neutral contract between the engine and
// every client (built-in web app, V1.5 CLI, future external games — Brief §1).
// It is MIT-licensed and must never import from apps/* (license fence, Guide A12).

/**
 * Protocol semver, sent in the handshake. Major bumps signal breaking wire
 * changes; CI blocks schema removals without one (Invariant I7).
 * 0.2.0: interrupt-turn command; sublocation.changed + art.switched events;
 * scene.ended end_type/divider_text; dev.tool_call/dev.tool_rejected frames.
 * 0.3.0: plugin.rejected event; GET /v1/plugins wire shapes (PluginInfo).
 * 0.4.0: sublocation.changed optional map_position (map connector surface);
 * GET /v1/images/* serves painter outputs (tile source).
 * 0.5.0: update.available + update.staged events; apply-update command
 * (self-update path, FINAL item 12 / Guide B12).
 * 0.6.0: wl-map-jump DOM event detail (map connector surface, UI Spec §1.14).
 * 0.7.0: character.joined event (scene roster projection — the VN line-up
 * renders the cast from the stream instead of a fixture constant).
 * 0.8.0: sublocation.materialized event (fog projection: explored =
 * materialized); explore command (one LLM-class materialize job per square);
 * open-scene optional sublocation_id (open a scene AT a known sublocation);
 * hello optional app_version.
 * 0.9.0 (M5 part 2, Rev 4 §14): Flow A — map-edit command +
 * map_edit.requested + sublocation.created events (lasso/pencil edits);
 * Flow B — map-click command + map_click.resolved event (radius/footprint
 * enter bypass, VLM classify → story LLM → persist-or-discard); optional
 * job_key on job.failed/job.parked (clients tie failures back to their
 * command).
 * 0.10.0 (M6 part 1, Rev 4 §6): the in-scene creation loop —
 * sublocation.stub_created event (the Narrator's create_sublocation tool:
 * identity stubs, hot path; backdrops + materialization fire from it);
 * scene.ended optional next_scene (the "Jump to the next scene"
 * registration).
 * 0.11.0 (M6 part 2, Rev 4 §8/§11): Weltari Chat part one —
 * chat.message_committed + chat.ended + reflect_chat.committed +
 * cache.appended events (DMs on the ONE event stream; the CACHE store is a
 * projection); send-chat-message / exit-chat / start-scene-from-chat
 * commands (the startscene() bridge); scene.started optional premise +
 * place_request (the chat→scene handoff surface); subwiki.updated event
 * (Rev 4 §10: the World Agent's scene-end pass writes wiki entries for
 * Narrator-created sublocations that participated — transient places never).
 * 0.12.0 (M6 part 3, Rev 4 §8): proactive CRON DMs — chat.outreach_recorded
 * (eager generation: the push IS the message; natural key world +
 * occurrence_iso; stamped with both the real fire time and the fictional
 * game_time) and chat.thread_frozen (the 3-unanswered hard cap as a durable
 * event — the gateway's future push hook; a user reply resets the counter by
 * construction).
 * 0.13.0 (M6 part 4, Rev 4 §7, owner rulings 2026-07-10/11): invitation
 * expiry — scene.started optional invitation (character-chosen game-time
 * wait_hours + engine-stamped expires_at_game); scene.expired event (lazy
 * judgment at clock advances/triggers; closes the scene, releases presence,
 * rides one transaction with the hardcoded cache.appended absence entry);
 * chat.notice event (the red-line rollback notice after a critical tool
 * chain exhausts its retry ceiling).
 * 0.14.0 (M6 part 4, Rev 4 §8): group chats — chat.group_started /
 * chat.group_message_committed / chat.group_ended events (user-started only;
 * the Group-chat Narrator routes turns and NEVER narrates — router decisions
 * are log-only; a range close enqueues exactly one reflect_chat per member);
 * start-group-chat / send-group-message / exit-group-chat commands. The
 * proactive-DM occurrence_iso is a GAME-time boundary from 0.13.0 on (owner
 * ruling 2026-07-10/11: fires only when the world clock advances).
 * 0.15.0 (M6 part 5, Rev 4 §10/§11/§12, owner rulings 2026-07-11): the Feed —
 * social.post_committed (game-time cadence, natural key world +
 * occurrence_iso, acquaintance delivery) / social.reaction_committed (one
 * skill-triggered decision per picked recipient, cap env-tunable) /
 * social.reply_posted + social.reply_answered (feed-local comment threads:
 * the user replies, the comment's author answers — never routed into Chat);
 * feed-reply command; cache.appended origin gains `social` (latest-per-origin
 * keeps feed comments from shadowing scene memory). Wiki manual edits —
 * subwiki.edited event (USER actor provenance, applies immediately; the
 * Proposal pipeline is deferred) + subwiki-edit command.
 * 0.16.0 (M7 part 1, Rev 4 §11/§4.2/§7, owner rulings 2026-07-11): the real
 * memory store — memory.delta_committed (append-only archive deltas, the
 * FTS5 Search Index projection's source) / memory.core_updated (full durable
 * core snapshot; prompts inject seed + latest — I5 holds) /
 * character.evolved (personality/goals evolution behind the per-character
 * locked flag) / memory.compacted (cumulative summary over old deltas;
 * re-runs supersede — repair for free, the log stays append-only) /
 * cache.pruned (retention as a view watermark, never a deletion). All five
 * emitted only by reflection-class/maintenance ledger jobs through the
 * character's serial group.
 * 0.17.0 (M7 part 2, Rev 4 §9/§15/§16, owner rulings 2026-07-11): the GM
 * agent — proposal.submitted (the uniform consent object {action, diff,
 * rationale, proposer, approvers[]}; a closed per-action diff union) /
 * proposal.resolved (approve applies atomically, reject leaves zero domain
 * rows) / character.created (consent-gated seed profiles — the live-profile
 * fold's event-borne seed layer) / world.seeded (cold boot's terminal state)
 * / gateway.binding_established (gates the once-per-binding GM onboarding
 * push) / config.flag_set (world flags as latest-wins folds;
 * profiling_enabled) / character.lock_set (the user-facing evolution lock) /
 * profile.updated + profile.deleted (references only — hypotheses live in a
 * deletable side store outside the log: GDPR). sublocation.materialized
 * gains optional space + proposal_id; subwiki.edited gains optional
 * proposal_id (both additive). Commands: resolve-proposal, set-config-flag,
 * set-character-lock, delete-profile. GET /v1/profile (+ /export) wire
 * shape: UserProfileView (entries + the profiling_enabled fold — the
 * hypotheses travel only over this surface, never the event stream).
 * 0.18.0 (M7 part 3, Rev 4 §7/§14/§17, owner ruling 2026-07-16: backpacks —
 * character/user holders, transfer_object, the secrecy rule, the backpack UI
 * — defer to V2; V1 objects are sublocation-held only, hence public):
 * object.created (materialize-on-touch: a character's gated interact_object
 * or a resolve-proposal apply — narrated-but-untouched scenery never becomes
 * data) / object.payload_written (character authoring or the Narrator's
 * write-on-first-read, persisted exactly once) / object.moved (one pointer
 * update, sublocation → sublocation) / object.swept (the GC tombstone: the
 * row leaves the projection, the log stays append-only — I1). The objects
 * table is a same-transaction fold of these events owned by a sole-writer
 * repository. The §16 proposal union gains action `create_object`
 * (ProposalObjectDiff: name + holder_sublocation_id + optional payload) —
 * GM-authored objects ride the existing consent seam and are never GC
 * candidates (no creating scene).
 * 0.19.0 (M7 part 4, Rev 4 §14/§17, the living-world loop): chance-encounter
 * markers — marker.dropped (a LAZY intent: sublocation + involved characters
 * + premise seed + game-time TTL; nothing generates until clicked; the map
 * holds 1–5 live markers — engine top-up below the minimum, drops refused at
 * the maximum, born-expired markers never dropped) / marker.instantiated
 * (first click wins: flips dropped → instantiated atomically with
 * scene.started; a racing second click joins the same scene, never twins) /
 * marker.expired (lazy expiry against the world clock — the sweep at every
 * clock advance + boot, or a click on an expired-but-unswept marker refusing
 * and settling it; a skipped encounter never happened — I1 tombstone
 * semantics). CRON world movement — character.location_changed (code-class
 * pointer updates at world-cron occurrences: presence-checked, materialized
 * targets only, idempotent per occurrence; the map's position bubbles read
 * these). The markers table is a same-transaction fold owned by a
 * sole-writer repository (the objects-table pattern). Command: marker-click
 * (202 outcome instantiated | join). MapJumpDetail gains optional scene_id
 * (additive): a marker click's jump enters the already-open scene instead
 * of minting one.
 * 0.20.0 (the GM proposal UX contract, Rev 4 §9/§16, owner ruling
 * 2026-07-11): the GM works like a coding agent's tool loop.
 * StreamSentence.call gains 'gm' (additive) — GM prose streams
 * display-only into the GM thread, turn_id carrying the conversation id;
 * the committed chat.message_committed stays the authoritative transcript
 * (B6). New command discuss-proposal + event proposal.discussed: the
 * "Chat about this" click as a durable signal the GM's next turn reads —
 * the proposal stays pending, zero domain rows (I8). The consent verdict
 * itself already rides proposal.resolved; the durable tool-result turn
 * consumes it server-side, no wire change.
 * 0.21.0 (the agentic scene, Rev 4 §6): the Narrator drives the turn.
 * character.left — the Narrator's character_leave, atomic with its
 * turn.committed; releases presence for this scene only while the scene
 * stays open. scene.goals_updated — the update_goals structured subgoal
 * snapshot (SceneGoalSchema {id, text, status}), atomic with its turn; the
 * engine reinjects the latest snapshot every Narrator turn, so a restart
 * resumes at the exact story position. scene.ended's end_type gains
 * `context_limit_reached` (the Scene Engine's context-budget warning ended
 * the scene; buttons render like rest) and next_scene grows the FULL Rev 4
 * §6 registration — time_offset_hours, expected_participants[],
 * brief_history, carried_goals[] — all optional on the wire (pre-0.21 logs
 * parse) but required by the tool gate. scene.started gains optional
 * brief_history + carried_goals: the consumed registration, folded in by
 * the engine when a scene opens at the registered sublocation — the jump
 * is a real continuation. character.joined now also arrives mid-scene from
 * make_character (same shape); character.location_changed now also arrives
 * from the Narrator's move_character (actor = the narrator, not
 * system:world_cron — consumers keying on the actor must accept both).
 */
export const PROTOCOL_VERSION = '0.21.0';

export {
  ArtSwitchedEventSchema,
  CacheAppendedEventSchema,
  CachePrunedEventSchema,
  CharacterCreatedEventSchema,
  CharacterEvolvedEventSchema,
  CharacterJoinedEventSchema,
  CharacterLeftEventSchema,
  CharacterLockSetEventSchema,
  ConfigFlagSetEventSchema,
  GatewayBindingEstablishedEventSchema,
  ChatEndedEventSchema,
  ChatMessageCommittedEventSchema,
  ChatGroupEndedEventSchema,
  ChatGroupMessageCommittedEventSchema,
  ChatGroupStartedEventSchema,
  ChatNoticeEventSchema,
  ChatOutreachRecordedEventSchema,
  ChatThreadFrozenEventSchema,
  ReflectChatCommittedEventSchema,
  ImageRegionSchema,
  MAP_FOG_GRID,
  MapPositionSchema,
  type MapPosition,
  MapSquareSchema,
  type MapSquare,
  JobErrorSchema,
  JobFailedEventSchema,
  JobParkedEventSchema,
  MapClickResolvedEventSchema,
  MapEditRequestedEventSchema,
  MarkerDroppedEventSchema,
  MarkerExpiredEventSchema,
  MarkerInstantiatedEventSchema,
  CharacterLocationChangedEventSchema,
  MemoryCompactedEventSchema,
  MemoryCoreUpdatedEventSchema,
  MemoryDeltaCommittedEventSchema,
  ObjectCreatedEventSchema,
  ObjectMovedEventSchema,
  ObjectPayloadWrittenEventSchema,
  ObjectSweptEventSchema,
  PainterCompletedEventSchema,
  PluginRejectedEventSchema,
  ProfileDeletedEventSchema,
  ProfileUpdatedEventSchema,
  ProposalCharacterDiffSchema,
  ProposalObjectDiffSchema,
  ProposalPlaceDiffSchema,
  ProposalDiscussedEventSchema,
  ProposalResolvedEventSchema,
  ProposalSubmittedEventSchema,
  ReflectionCommittedEventSchema,
  SceneEndedEventSchema,
  SceneExpiredEventSchema,
  SceneGoalSchema,
  SceneGoalsUpdatedEventSchema,
  SceneStartedEventSchema,
  SocialPostCommittedEventSchema,
  SocialReactionCommittedEventSchema,
  SocialReplyAnsweredEventSchema,
  SocialReplyPostedEventSchema,
  SublocationChangedEventSchema,
  SublocationCreatedEventSchema,
  SublocationMaterializedEventSchema,
  SublocationStubCreatedEventSchema,
  SubwikiEditedEventSchema,
  SubwikiUpdatedEventSchema,
  TurnCommittedEventSchema,
  TurnStartedEventSchema,
  TurnStepSchema,
  UpdateAvailableEventSchema,
  UpdateStagedEventSchema,
  WeltariEventSchema,
  WorldAgentCommittedEventSchema,
  WorldCronCompletedEventSchema,
  WorldSeededEventSchema,
  WorldTimeAdvancedEventSchema,
  type ImageRegion,
  type ProposalCharacterDiff,
  type ProposalObjectDiff,
  type ProposalPlaceDiff,
  type SceneGoal,
  type TurnStep,
  type WeltariEvent,
  type WeltariEventType,
} from './events.js';
export {
  StreamHelloSchema,
  StreamSentenceSchema,
  type StreamHello,
  type StreamSentence,
} from './stream.js';
export {
  MapJumpDetailSchema,
  PluginInfoSchema,
  PluginListSchema,
  type MapJumpDetail,
  type PluginInfo,
  type PluginList,
} from './plugins.js';
export {
  ProfileEntrySchema,
  UserProfileViewSchema,
  type ProfileEntry,
  type UserProfileView,
} from './profile.js';
export {
  DevEventSchema,
  DevGaugesSchema,
  DevToolCallSchema,
  DevToolRejectedSchema,
  type DevEvent,
  type DevGauges,
  type DevToolCall,
  type DevToolRejected,
} from './dev.js';
export {
  AdvanceTimeAcceptedSchema,
  AdvanceTimeCommandSchema,
  ApplyUpdateAcceptedSchema,
  ApplyUpdateCommandSchema,
  CommandRejectedSchema,
  DeleteProfileAcceptedSchema,
  DeleteProfileCommandSchema,
  EndSceneAcceptedSchema,
  EndSceneCommandSchema,
  ExitChatAcceptedSchema,
  ExitChatCommandSchema,
  ExitGroupChatAcceptedSchema,
  ExitGroupChatCommandSchema,
  ExploreAcceptedSchema,
  ExploreCommandSchema,
  FeedReplyAcceptedSchema,
  FeedReplyCommandSchema,
  InterruptTurnAcceptedSchema,
  InterruptTurnCommandSchema,
  MapClickAcceptedSchema,
  MapClickCommandSchema,
  MapEditAcceptedSchema,
  MapEditCommandSchema,
  MarkerClickAcceptedSchema,
  MarkerClickCommandSchema,
  OpenSceneAcceptedSchema,
  OpenSceneCommandSchema,
  PaintRegionAcceptedSchema,
  PaintRegionCommandSchema,
  DiscussProposalAcceptedSchema,
  DiscussProposalCommandSchema,
  ResolveProposalAcceptedSchema,
  ResolveProposalCommandSchema,
  SendChatMessageAcceptedSchema,
  SendChatMessageCommandSchema,
  SetCharacterLockAcceptedSchema,
  SetCharacterLockCommandSchema,
  SetConfigFlagAcceptedSchema,
  SetConfigFlagCommandSchema,
  SendGroupMessageAcceptedSchema,
  SendGroupMessageCommandSchema,
  StartGroupChatAcceptedSchema,
  StartGroupChatCommandSchema,
  StartSceneFromChatAcceptedSchema,
  StartSceneFromChatCommandSchema,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  SubwikiEditAcceptedSchema,
  SubwikiEditCommandSchema,
  type AdvanceTimeAccepted,
  type AdvanceTimeCommand,
  type ApplyUpdateAccepted,
  type ApplyUpdateCommand,
  type CommandRejected,
  type DeleteProfileAccepted,
  type DeleteProfileCommand,
  type EndSceneAccepted,
  type EndSceneCommand,
  type ExitChatAccepted,
  type ExitChatCommand,
  type ExitGroupChatAccepted,
  type ExitGroupChatCommand,
  type ExploreAccepted,
  type ExploreCommand,
  type FeedReplyAccepted,
  type FeedReplyCommand,
  type InterruptTurnAccepted,
  type InterruptTurnCommand,
  type MapClickAccepted,
  type MapClickCommand,
  type MapEditAccepted,
  type MapEditCommand,
  type MarkerClickAccepted,
  type MarkerClickCommand,
  type OpenSceneAccepted,
  type OpenSceneCommand,
  type PaintRegionAccepted,
  type PaintRegionCommand,
  type DiscussProposalAccepted,
  type DiscussProposalCommand,
  type ResolveProposalAccepted,
  type ResolveProposalCommand,
  type SendChatMessageAccepted,
  type SendChatMessageCommand,
  type SetCharacterLockAccepted,
  type SetCharacterLockCommand,
  type SetConfigFlagAccepted,
  type SetConfigFlagCommand,
  type SendGroupMessageAccepted,
  type SendGroupMessageCommand,
  type StartGroupChatAccepted,
  type StartGroupChatCommand,
  type StartSceneFromChatAccepted,
  type StartSceneFromChatCommand,
  type StartTurnAccepted,
  type StartTurnCommand,
  type SubwikiEditAccepted,
  type SubwikiEditCommand,
} from './commands.js';
