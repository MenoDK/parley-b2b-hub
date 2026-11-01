/** Time is an input, not a global. Every rule that depends on "now" takes a clock, so a test (or the lab) can move it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock the lab can push forward. It never goes back: moving time backwards would resurrect expired links. */
export class OffsetClock implements Clock {
  #offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.#offsetMs);
  }

  advance(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('time only moves forward');
    this.#offsetMs += seconds * 1000;
  }

  get offsetSeconds(): number {
    return Math.round(this.#offsetMs / 1000);
  }

  reset(): void {
    this.#offsetMs = 0;
  }
}

export const toEpochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);
