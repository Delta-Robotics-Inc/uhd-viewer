/**
 * Playing a tour live (PB-1188), with the turn-taking rule from the
 * research (decision 6): any input from the person takes over and pauses
 * the tour; it resumes on request, or by itself after `resumeAfterS` of
 * quiet (DEFAULT 25 s, teardown's figure; user-settable). Each frame is
 * still `tourAt(tour, time)`: the clock is the only state.
 */
import { tourAt, tourDuration } from "./play";
import type { Tour, TourContext, TourFrame } from "./types";

export const DEFAULT_RESUME_AFTER_S = 25;

export interface TourPlaybackState {
  playing: boolean;
  /** Who drives the view now. */
  driver: "tour" | "user";
  /** Seconds into the tour. */
  time: number;
  /** Seconds since the person's last input (while they drive). */
  idleS: number;
  done: boolean;
}

export class TourPlayback {
  private time = 0;
  private idle = 0;
  private driver: "tour" | "user" = "tour";
  private stopped = false;

  constructor(
    readonly tour: Tour,
    private readonly ctx: TourContext = {},
    private readonly opts: { resumeAfterS?: number | null; speed?: number } = {},
  ) {}

  /** Advance by dt seconds: the frame to show, or undefined while the person drives or after a stop. */
  tick(dtS: number): TourFrame | undefined {
    if (this.stopped) return undefined;
    if (this.driver === "user") {
      this.idle += dtS;
      const after = this.opts.resumeAfterS === undefined ? DEFAULT_RESUME_AFTER_S : this.opts.resumeAfterS;
      if (after === null || this.idle < after) return undefined;
      this.driver = "tour";
    }
    this.time += dtS * (this.opts.speed ?? 1);
    const f = tourAt(this.tour, this.time, this.ctx);
    if (f.done) this.stopped = true;
    return f;
  }

  /** The person touched the view (pointer, wheel, key): the tour pauses where it is. */
  userInput(): void {
    if (this.stopped) return;
    this.driver = "user";
    this.idle = 0;
  }

  /** Hand the view back to the tour now. */
  resume(): void {
    this.stopped = false;
    this.driver = "tour";
  }

  stop(): void {
    this.stopped = true;
  }

  /** Jump to a time (a scrub bar). */
  seek(time: number): TourFrame {
    this.time = Math.max(0, Math.min(tourDuration(this.tour), time));
    return tourAt(this.tour, this.time, this.ctx);
  }

  state(): TourPlaybackState {
    return { playing: !this.stopped && this.driver === "tour", driver: this.driver, time: this.time, idleS: this.idle, done: this.stopped && !this.tour.loop && this.time >= tourDuration(this.tour) };
  }
}
