/**
 * Pluggable time source for the audio engine and time-based visual effects.
 *
 * Default: real wall clock (`performance.now() / 1000`). The video exporter
 * (when added) swaps in a virtual clock so the engine + visualizers can be
 * stepped at non-realtime frame intervals deterministically — the same scene
 * is rendered at e.g. 60 fps virtual time regardless of how long each frame
 * actually takes to encode.
 *
 * `now()` returns seconds. The absolute origin is unspecified — only deltas
 * between successive calls are meaningful.
 *
 * The realtime recorder (`audio/recorder.ts`) and live MIDI input
 * (`audio/midiInput.ts`) intentionally still call `performance.now()`
 * directly: they only operate during live user performance, never under a
 * virtualised clock, so virtualising them would only invite drift bugs.
 */
export interface Clock {
  now(): number
}

const realClock: Clock = {
  now: () => performance.now() / 1000,
}

let active: Clock = realClock
let epoch = 0

export function setActiveClock(clock: Clock): void {
  active = clock
  epoch++
}

export function resetActiveClock(): void {
  active = realClock
  epoch++
}

/**
 * Bumped every time the active clock is swapped.
 *
 * `now()` is monotonic only WITHIN an epoch: the offline exporter
 * installs a `VirtualClock` that restarts at 0, so the wall-clock value
 * a live session was running on (`performance.now() / 1000`, which can
 * be anything from seconds to hours) jumps backwards at the start of a
 * render, and forwards again when the real clock is restored.
 *
 * Any state holding an ABSOLUTE timestamp is therefore meaningless
 * across a change and has to be re-anchored — a per-key "keep the
 * landing flash lit until T" deadline from the previous epoch sits in
 * the future of the entire render, so the flash never turns off; a
 * particle integrator that takes the raw difference gets a hugely
 * negative `dt` and drives its exponential drag to Infinity.
 *
 * Consumers keep the last epoch they saw in a ref and reset when it
 * moves. State that only stores DURATIONS (EMA filter memory, decay
 * factors) needs no attention.
 */
export function clockEpoch(): number {
  return epoch
}

export function now(): number {
  return active.now()
}

/**
 * Externally-driven clock for offline rendering. The video exporter
 * advances this between frames so every consumer of `now()` (engine,
 * particle systems, hit-line animation, custom-texture animator)
 * sees the same virtual time within a frame, and successive frames
 * land on a deterministic 1/fps grid regardless of how long each
 * actual frame takes to render and encode.
 *
 * `setTime` is preferred over `advance` for offline use: cumulative
 * floating-point error from many tiny `advance` calls would
 * eventually drift the timeline against the underlying song; setting
 * an absolute `frame / fps` keeps each frame's virtual time exact
 * regardless of how many came before it.
 */
export class VirtualClock implements Clock {
  private t = 0
  now(): number {
    return this.t
  }
  setTime(seconds: number): void {
    this.t = seconds
  }
  advance(seconds: number): void {
    this.t += seconds
  }
}
