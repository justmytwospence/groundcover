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

/** Wall-clock seconds for one route to draw itself, at any timeline speed. */
export const ROUTE_DRAW_SECONDS = 1.1;

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
export function routeDrawSpanSeconds(timelineSpanS: number, speed: number): number {
  const simulatedPerWallSecond = (timelineSpanS / PLAYBACK_SECONDS) * Math.max(0.01, speed);
  return ROUTE_DRAW_SECONDS * simulatedPerWallSecond;
}

/**
 * Whether ground first covered at `mintTs` is visible yet.
 *
 * Extracted from the render loop so the arithmetic can be tested directly: it decides what a
 * viewer sees frame by frame, and it is the kind of thing that looks obviously right and is
 * quietly off by a factor.
 *
 * @param mintTs   when this ground was first covered
 * @param actStart first moment its activity minted anything
 * @param actEnd   last moment its activity minted anything
 * @param revealTs the playhead
 * @param drawSpanS timeline seconds to stretch the activity's draw across; 0 disables stretching
 */
export function isRevealed(
  mintTs: number,
  actStart: number,
  actEnd: number,
  revealTs: number,
  drawSpanS: number,
): boolean {
  if (!(drawSpanS > 0) || !Number.isFinite(revealTs)) return mintTs <= revealTs;
  const dur = actEnd - actStart;
  const frac = dur > 0 ? (mintTs - actStart) / dur : 0;
  return actStart + frac * drawSpanS <= revealTs;
}
