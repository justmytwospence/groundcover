/**
 * How fast the time-lapse runs, and how fast a single route draws itself.
 *
 * These are two different clocks and conflating them is why routes used to snap into existence.
 * The timeline crosses years in seconds; an activity occupies an hour or two of that timeline,
 * which at any watchable overall pace is a single frame. Slowing the timeline cannot fix it,
 * because the route's draw is measured in the same units and slows with it.
 *
 * So the draw gets its own duration, expressed in wall-clock seconds and converted to whatever
 * span of timeline that currently corresponds to.
 */

/** Wall-clock seconds for a full history to play at 1x. */
export const PLAYBACK_SECONDS = 180;

/**
 * Bounds on how long one route takes to draw, in wall-clock seconds.
 *
 * The floor is what "slow enough to notice it growing" costs: below roughly a third of a second
 * a stroke reads as an appearance rather than a movement. The ceiling stops a short selection
 * from crawling.
 */
export const ROUTE_DRAW_MIN_S = 0.35;
export const ROUTE_DRAW_MAX_S = 1.2;

/**
 * The longest empty stretch the sweep will actually traverse, when skipping is on.
 *
 * Gaps are compressed to this rather than removed outright: jumping straight from one activity
 * to the next erases any sense of time passing, and a history with a three-month injury in it
 * should still feel like it had one.
 */
export const MAX_EMPTY_GAP_S = 12 * 3600;

/**
 * The span of timeline, in seconds, that one route's draw should be stretched across.
 *
 * An activity is revealed over this much simulated time regardless of how long it actually
 * took, so a twenty-minute jog and a six-hour ride draw at the same visible rate. Routes
 * therefore trail slightly behind the playhead and several draw at once, which is the intended
 * effect rather than a side effect: a history arriving in overlapping strokes reads as alive,
 * where a strict one-at-a-time queue would read as a progress bar.
 *
 * @param timelineSpanS the span the current playback run covers
 * @param speed the transport's speed multiplier
 */
/**
 * How much timeline the sweep will actually cross between `from` and `to`.
 *
 * With skipping off this is simply the span. With it on, every empty stretch counts for at most
 * MAX_EMPTY_GAP_S -- which is what lets the run keep its wall-clock budget while spending it on
 * the parts where something happens.
 *
 * @param starts activity start times inside the range, ascending
 */
/**
 * Wall-clock seconds one route should take, given how many are in the run.
 *
 * Exactly one draws at a time, so the run costs (routes x this). Those two wishes fight: 1,300
 * activities at a leisurely second each is twenty minutes, while holding the run to three
 * minutes forces a seventh of a second per route, which is the snapping this exists to fix. So
 * it is derived from the count and clamped -- a short selection gets an unhurried draw, a whole
 * history a brisk but still legible one.
 */
export function routeDrawSeconds(routeCount: number): number {
  if (routeCount <= 0) return ROUTE_DRAW_MAX_S;
  const even = PLAYBACK_SECONDS / routeCount;
  return Math.min(ROUTE_DRAW_MAX_S, Math.max(ROUTE_DRAW_MIN_S, even));
}

export function traversedSpanSeconds(
  from: number,
  to: number,
  starts: readonly number[],
  skipEmpty: boolean,
): number {
  if (!skipEmpty) return Math.max(1, to - from);
  let total = 0;
  let cursor = from;
  for (const s of starts) {
    if (s <= cursor) continue;
    if (s > to) break;
    total += Math.min(s - cursor, MAX_EMPTY_GAP_S);
    cursor = s;
  }
  total += Math.min(Math.max(0, to - cursor), MAX_EMPTY_GAP_S);
  return Math.max(1, total);
}



/** One route in the replay: the span over which it first covered new ground. */
export interface Route {
  from: number;
  to: number;
}

/**
 * Where a playhead sits within a reel: which route, and how far through it.
 *
 * Derived rather than remembered. The reel is rebuilt whenever new history lands, and a Strava
 * sync arrives newest first, so each batch inserts older activities at the front and shifts
 * every index. An index carried across that rebuild points at a different route and the replay
 * jumps somewhere else in time; a timestamp means the same thing whatever the reel looks like.
 */
export function cueAt(
  reel: readonly Route[],
  playhead: number | null,
  reverse = false,
): { i: number; t: number } {
  if (reel.length === 0 || playhead === null) return { i: 0, t: 0 };
  let i = 0;
  if (reverse) while (i < reel.length - 1 && reel[i].from > playhead) i++;
  else while (i < reel.length - 1 && reel[i].to < playhead) i++;
  const r = reel[i];
  const dur = r.to - r.from;
  if (!(dur > 0)) return { i, t: 0 };
  const done = reverse ? (r.to - playhead) / dur : (playhead - r.from) / dur;
  return { i, t: Math.min(0.999, Math.max(0, done)) };
}

export interface Cue {
  /** Index into the ordered reel. */
  i: number;
  /** How far through that route, 0 to 1. */
  t: number;
}

export interface Step {
  cue: Cue;
  playhead: number;
  done: boolean;
}

/**
 * Advance the replay by `dt` wall-clock seconds.
 *
 * Pure, because it decides the order a viewer sees their history in, and "is this sequence
 * monotone" is a question worth answering with a test rather than by reading a render loop.
 *
 * @param order  the reel, already in the direction of travel
 * @param cue    where the replay currently is
 * @param dt     wall seconds, already scaled by the speed multiplier
 * @param drawS  wall seconds one route takes to draw
 * @param gapS   wall seconds to cross the gap after the current route
 * @param reverse whether the reel is being walked newest-first
 */
export function stepReplay(
  order: readonly Route[],
  cue: Cue,
  dt: number,
  drawS: number,
  gapS: number,
  reverse: boolean,
): Step {
  const route = order[cue.i];
  if (!route) return { cue, playhead: 0, done: true };

  const t = cue.t + dt / Math.max(drawS, 1e-6);
  const span = route.to - route.from;

  if (t < 1) {
    const head = reverse ? route.to - span * t : route.from + span * t;
    return { cue: { i: cue.i, t }, playhead: head, done: false };
  }

  const nextI = cue.i + 1;
  if (nextI >= order.length) {
    // Finish ON the last route's far edge rather than wherever the overshoot landed, so the
    // final frame is the whole route and not a fraction past it.
    return { cue, playhead: reverse ? route.from : route.to, done: true };
  }

  const next = order[nextI];
  const over = (t - 1) * drawS;
  if (over < gapS) {
    // Still crossing the gap. The cue stays put; only the playhead moves, through empty ground.
    const gap = reverse ? route.from - next.to : next.from - route.to;
    const frac = over / Math.max(gapS, 1e-6);
    return {
      cue: { i: cue.i, t },
      playhead: reverse ? route.from - gap * frac : route.to + gap * frac,
      done: false,
    };
  }

  // On to the next route, carrying the overshoot so the pace does not stutter at the seam. The
  // playhead must agree with the carried fraction, or a re-derived cue would disagree with it
  // and the replay would jump.
  const carried = Math.min(0.999, (over - gapS) / Math.max(drawS, 1e-6));
  const nextSpan = next.to - next.from;
  return {
    cue: { i: nextI, t: carried },
    playhead: reverse ? next.to - nextSpan * carried : next.from + nextSpan * carried,
    done: false,
  };
}
