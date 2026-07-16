// Kill-harness fault points (Invariant I4). Names are the contract with
// tools/kill-harness.mjs — the harness greps stdout for FAULT_POINT:<name>
// and SIGKILLs inside the window. The M2 table (Brief §4): mid_reflection,
// mid_painter, mid_cron join the Week-1 three.
export type FaultPoint =
  | 'mid_stream'
  | 'between_calls'
  | 'pre_commit'
  | 'mid_reflection'
  | 'mid_painter'
  | 'mid_cron'
  /** M3 part 2: inside the update apply window — verified, not yet flipped. */
  | 'mid_update'
  /** M4 part 2: inside the materialize job — stub generated + both B6 gates
   * passed, sublocation.materialized not yet appended. */
  | 'mid_materialize'
  /** M5 part 2: inside the map_edit job — GM form generated + both B6 gates
   * passed, sublocation.created not yet appended (the paint enqueue follows
   * the append; a kill between them heals via the created-exists re-enqueue). */
  | 'mid_map_edit'
  /** M5 part 2: inside the map_click job — classification + story invention
   * generated + gated, map_click.resolved not yet appended. */
  | 'mid_map_click'
  /** M6 part 2: inside the reflect_chat job — the reflection generated,
   * reflect_chat.committed not yet appended. */
  | 'mid_reflect_chat'
  /** M6 part 3: inside the proactive_dm job — the DM generated, the
   * message + outreach (+ freeze) transaction not yet appended. */
  | 'mid_proactive_dm'
  /** M6 part 4: inside the invitation expiry sweep — the invitation is due,
   * the scene.expired + cache.appended pair not yet appended (a kill heals
   * at the boot sweep; the fused re-check keeps the pair single). */
  | 'mid_invitation_expiry'
  /** M6 part 5: inside the social_post job — the post generated, the
   * post + poster-CACHE + reaction-job transaction not yet appended. */
  | 'mid_social_post'
  /** M7 part 1: inside the memory-commit window of BOTH reflection handlers —
   * deltas/core/evolution generated and gated, the atomic append (committed
   * event + CACHE + memory events) not yet written. Retry must converge to
   * exactly one delta set per (character, scene/range). */
  | 'mid_memory_commit'
  /** M7 part 1: inside the memory_compaction job — the summary generated,
   * memory.compacted not yet appended (idempotent per character+up_to_id). */
  | 'mid_compaction'
  /** M7 part 2: inside the resolve-proposal apply window — every gate passed,
   * the atomic append (proposal.resolved + the applied domain events + their
   * jobs) not yet written. A retried resolve must converge to exactly one
   * application per proposal_id (the fused re-check refuses the second). */
  | 'mid_proposal_apply'
  /** M7 part 2: inside the profile_analysis job — hypotheses generated and
   * gated, the transaction (side-store rows + profile.updated) not yet
   * written. Idempotent per (actor, context): the retry commits exactly one
   * hypothesis set per ended scene/chat range. */
  | 'mid_profile_analysis'
  /** M7 part 3: inside the object_gc job — the sweep is due, the transaction
   * (object.swept tombstones + their same-transaction row deletions) not yet
   * written. Candidates are recomputed INSIDE the transaction, so a retry
   * converges: already-swept strays are simply no longer candidates. */
  | 'mid_object_gc';

/**
 * May pause (return a promise) so the harness SIGKILL lands inside the window;
 * callers in a durable path await it right BEFORE their commit write.
 */
export type FaultPointHook = (point: FaultPoint) => void | Promise<void>;
