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
  | 'mid_update';

/**
 * May pause (return a promise) so the harness SIGKILL lands inside the window;
 * callers in a durable path await it right BEFORE their commit write.
 */
export type FaultPointHook = (point: FaultPoint) => void | Promise<void>;
