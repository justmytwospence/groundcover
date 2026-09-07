/**
 * The map palette, in one place.
 *
 * It used to live in three: `PALETTES` here in lib, a private `GRADIENT` copy inside
 * query.worker.ts, and the custom properties in theme.css. The worker's copy is the one that
 * paints the map, so editing the other two changed the legend and nothing else -- which is
 * exactly how a validated palette change shipped without changing a single pixel of coverage.
 * This module is now the source both TypeScript consumers import and the checker reads; the CSS
 * tokens still have to be edited alongside it, which `npm run palette` cannot enforce but
 * SPEC.md section 6.2 spells out.
 *
 * Deliberately free of DOM access so the worker can import it.
 */

export type Theme = 'dark' | 'light';

export interface Palette {
  /** Banded ramp for exploration mode: [frontier, 2-4, 5-9, 10+, 10+]. */
  exploration: string[];
  /** Banded ramp for heatmap mode: [1, 2-4, 5-9, 10-24, 25+]. */
  heatmap: string[];
  /** Reserved accent for ground covered exactly once, in one direction. */
  frontier: string;
  /** Reserved accent for ground covered more than once but never the other way. */
  oneWay: string;
  /** Continuous ramp, sampled per site and rescaled to the busiest visible ground. */
  gradient: string[];
}

/** The surface each palette was selected against. */
export const MAP_SURFACE: Record<Theme, string> = { dark: '#1b1f27', light: '#f4f4f1' };

/**
 * What the basemap draws water with, which a coverage line has to stay distinguishable from.
 * Sampled from the styles the app actually loads: OpenFreeMap positron/dark and CARTO positron.
 *
 * Water *labels* (#495e91, #7a96a0) are deliberately absent. They are haloed text covering a
 * few hundred pixels a screen, and holding a whole ramp away from them is what pinned the old
 * light palette into the blue it had to escape.
 */
export const BASEMAP_WATER: Record<Theme, string[]> = {
  light: ['#c2ccd0', '#c2c8ca', '#d1dbdf', '#d4dadc'],
  dark: ['#1b1b1d'],
};

/** Road fills and casings, the other thing a line can be mistaken for. */
export const BASEMAP_ROAD: Record<Theme, string[]> = {
  light: ['#ffffff', '#f8f4f0', '#e0e0e0', '#d5d5d5', '#838383', '#666666'],
  dark: ['#0c0c0c', '#2a2e37'],
};

/**
 * Opacity each mode paints at, 0-255.
 *
 * Heatmap is translucent so overlapping passes accumulate. On dark that accumulation is
 * additive and 90 is plenty -- each pass adds light. On light, additive blending would drive
 * the colour toward white, so light mode composites normally (MapView) and needs a much higher
 * alpha to survive being drawn over a near-white surface at hairline width.
 */
export const MODE_ALPHA: Record<Theme, { exploration: number; heatmap: number }> = {
  dark: { exploration: 255, heatmap: 90 },
  light: { exploration: 255, heatmap: 190 },
};

/**
 * Exploration: two reserved accents, then a single-hue ordinal ramp for depth. The last entry
 * repeats the top step because the band function has one more band than the ramp has distinct
 * steps.
 *
 * `oneWay` is the second accent: ground walked more than once but never the other way. It is a
 * category, not a rung -- a loop run fifty times is still one-way -- so it sits outside the
 * ramp for the same reason the frontier does.
 *
 * **The depth ramp could not go warm with it, and that was measured rather than argued.** The
 * ask was a yellow-orange-red exploration mode. On the light surface it is achievable: hue 30
 * clears every criterion. On the dark surface nothing warm does, at any hue, and the reason is
 * structural -- a dark surface reads brighter as more, so the ramp has to live at the top of
 * the lightness range, which is exactly where the gold frontier already is. Every warm ramp
 * therefore lands a step on top of gold: the closest sits 1.7 apart under protanopia against a
 * floor of 8, meaning a colour-blind viewer sees new ground and well-worn ground as one colour.
 * Going warm on dark means giving up the gold frontier, which is a bigger change than the one
 * being asked for. A single accent has the freedom a ramp does not, because it can be parked
 * away from gold's lightness rather than sweeping through it: #d94f2b sits 15.9 from gold and
 * 22.5 from the nearest ramp step. Re-derive all of this with `npm run palette`.
 *
 * The two palettes are not transforms of each other. On a dark surface brighter means more, so
 * the repeat ramp climbs toward white; on a light surface that reads backwards, so it descends
 * toward near-black instead.
 *
 * Light is indigo rather than blue because the light basemap draws rivers in blue-grey and a
 * hairline of #4a86cf was, measurably, the same feature. See SPEC.md section 6.2 and run
 * `npm run palette` after changing anything here.
 */
export const PALETTES: Record<Theme, Palette> = {
  dark: {
    exploration: ['#eda100', '#256abf', '#5598e7', '#9ec5f4', '#9ec5f4'],
    heatmap: ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
    frontier: '#eda100',
    oneWay: '#d94f2b',
    gradient: ['#256abf', '#3579cd', '#4a86cf', '#5598e7', '#79b0ef', '#9ec5f4'],
  },
  light: {
    exploration: ['#c07a00', '#5b52e8', '#3822a0', '#1c0f5e', '#1c0f5e'],
    heatmap: ['#5b52e8', '#4a34c9', '#3822a0', '#261577', '#170a4d'],
    frontier: '#c07a00',
    oneWay: '#a8321a',
    gradient: ['#5b52e8', '#5346d9', '#4a34c9', '#4029b4', '#3822a0', '#2b1a80'],
  },
};
