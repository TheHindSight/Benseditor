/**
 * Turns real elapsed time into a whole number of game steps.
 *
 * The game must step exactly `fps` times a second whatever the display's
 * refresh rate: a 120 Hz screen used to run everything twice as fast, and a
 * rhythm game cannot live with that. Time is accumulated and paid out in
 * whole steps; when the machine falls badly behind (a hitch, a backgrounded
 * tab) at most `maxCatchUp` steps run at once and the rest of the backlog is
 * dropped, so the game slows rather than spiralling.
 */
export class FixedStepClock {
  private accumulator: number;

  constructor(
    readonly stepSeconds: number,
    readonly maxCatchUp = 3,
  ) {
    // Primed so the very first tick runs a step and draws something.
    this.accumulator = stepSeconds;
  }

  /** Feed real elapsed seconds; returns how many steps to run now. */
  advance(elapsed: number): number {
    this.accumulator += Math.min(0.25, Math.max(0, elapsed));
    // A hair of tolerance: 144 frames of 1/144 s sum to fractionally under a
    // second in floating point, and must still be 60 steps.
    let steps = Math.floor(this.accumulator / this.stepSeconds + 1e-6);
    if (steps > this.maxCatchUp) {
      steps = this.maxCatchUp;
      this.accumulator = 0;
    } else {
      this.accumulator = Math.max(0, this.accumulator - steps * this.stepSeconds);
    }
    return steps;
  }
}
