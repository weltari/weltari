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
  | 'mid_map_edit';

/**
 * May pause (return a promise) so the harness SIGKILL lands inside the window;
 * callers in a durable path await it right BEFORE their commit write.
 */
export type FaultPointHook = (point: FaultPoint) => void | Promise<void>;
