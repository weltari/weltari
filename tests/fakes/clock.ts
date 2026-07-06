// Fake wall clock for ledger/lease tests — all time is injected, zero sleeps
// (Invariants "How AI agents write tests" rule 1).
export class FakeClock {
  private ms: number;

  constructor(startIso = '2026-07-06T00:00:00.000Z') {
    this.ms = new Date(startIso).getTime();
  }

  nowIso = (): string => new Date(this.ms).toISOString();

  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }
}
