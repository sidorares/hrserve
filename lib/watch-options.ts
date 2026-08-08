import type { WatchOptions as ChokidarOptions } from "chokidar";

/**
 * One debounce policy for every file hrserve watches.
 *
 * chokidar's default `change` handling throttles per path for 50ms on the
 * *leading* edge and never emits a trailing event (`_throttle(EV_CHANGE, path,
 * 50)` in its `_emit`), so a second save landing inside that window is dropped
 * with no trace. `awaitWriteFinish` takes an earlier branch of the same
 * function and returns before the throttle is ever consulted: it waits for the
 * file's size to hold still, then emits. Every save is reported, and a
 * half-written file is never read.
 */
export interface WatchOptions {
  /** ms a file's size must stay unchanged before the change is reported. */
  stabilityThreshold?: number;
  /** ms between size checks while waiting for a write to settle. */
  pollInterval?: number;
}

/**
 * Small on purpose: the threshold is added to the latency of every patch and
 * every mock reload, and no editor writes slowly enough for 50ms to matter.
 * Raise it (via `ServeOptions.watch`) for a network filesystem or an editor
 * that saves in several visible steps.
 */
export const WATCH_DEFAULTS: Required<WatchOptions> = {
  stabilityThreshold: 50,
  pollInterval: 10,
};

/**
 * chokidar options shared by the served-file watchers in `serve()` and the
 * mock handler watcher in `MockRouter`. Deliberately one knob rather than two:
 * the value tracks how a machine writes files, not what kind of file it is, so
 * a user who tunes it for a slow disk should not have to find a second setting
 * to tune for mocks.
 */
export function watchOptions(watch: WatchOptions = {}): ChokidarOptions {
  return {
    awaitWriteFinish: {
      stabilityThreshold: watch.stabilityThreshold ?? WATCH_DEFAULTS.stabilityThreshold,
      pollInterval: watch.pollInterval ?? WATCH_DEFAULTS.pollInterval,
    },
  };
}
