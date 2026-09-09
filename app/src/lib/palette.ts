/**
 * The map palette, in one place.
 *
 * It used to live in three: `PALETTES` here in lib, a private `GRADIENT` copy inside
 * query.worker.ts, and the custom properties in theme.css. The worker's copy is the one that
 * paints the map, so editing the other two changed the legend and nothing else -- which is
 * exactly how a validated palette change shipped without changing a single pixel of coverage.
 *
 * There is one copy now. The worker's is gone, and so are the CSS ramp tokens: `--repeat-*`
 * duplicated these values into a stylesheet that never painted them, kept honest only by a test
 * whose whole job was to police a duplication nothing needed. The legend reads the ramps from
 * here directly. theme.css keeps only the tokens CSS actually uses -- `--frontier` and friends.
 *
 * Deliberately free of DOM access so the worker can import it.
 */

export type Theme = 'dark' | 'light';

export interface Palette {
  /** Banded ramp for heatmap mode: [1, 2-4, 5-9, 10-24, 25+]. Direction plays no part. */
  heatmap: string[];
  /**
   * Accent for new ground.
   *
   * A user-interface colour, not a map colour. It is what the new-ground figure, the playhead
   * and the search highlight are painted with; exploration mode stopped drawing it when the map
   * went to two ramps, because "covered once" is no longer a category the map distinguishes --
   * one visit is simply the bottom of whichever ramp the ground belongs to.
   */
  frontier: string;
  /**
   * Exploration mode, ground travelled in one direction only. Sampled per site by visit count
   * and rescaled to the busiest visible ground; index 0 is a single visit.
   */
  oneWay: string[];
  /** Exploration mode, ground travelled both ways. Same scale, same length, different hue. */
  bothWays: string[];
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
 * Exploration paints two ramps at once: hue says which direction, lightness says how often.
 *
 * There is no reserved accent here any more. "Covered once" stopped being a category the map
 * distinguishes -- a single visit is simply the bottom of whichever ramp the ground belongs to,
 * and the new-ground figure in the stats card is where that question is actually answered. The
 * result is one rule the whole map obeys: warm means you have only ever gone one way, cool
 * means you have come back the other, and brighter (dark) or darker (light) means more often.
 *
 * **The two ramps share a lightness profile on purpose.** The encoding rests on lightness
 * meaning visit count and nothing else, so `oneWay` is derived by taking `bothWays`'s lightness
 * at every step and rebuilding it at a warm hue -- `npm run palette -- mirror 40 --dark
 * --floor 0.56` reproduces it exactly. Without that, a busy one-way street and a quiet two-way
 * street could land on the same brightness and the reader would have no way to tell which of
 * the two variables had moved.
 *
 * The floor is the one place the mirror is not exact, and it is not a fudge. `bothWays`'s
 * dimmest step, #256abf, clears the dark surface by 3.06:1 -- already the palette's thinnest
 * margin, and the step section 6.2 singles out as its known weak point. A warm hue at that same
 * lightness manages only 2.90:1, because WCAG luminance weights green heavily and a saturated
 * red has almost none, so mirroring it exactly would ship a step under the 3:1 floor. Raising
 * the warm ramp's weak end to L 0.56 clears it at 3.31:1 and costs one step of range.
 *
 * Warm was impossible here until the frontier left the map. Gold sat at the top of the dark
 * lightness range, which is where a dark-surface ramp has to live, so every warm ramp landed a
 * step on top of it -- 1.7 apart under protanopia against a floor of 8. Dropping the accent is
 * what freed the hue.
 *
 * The two palettes are not transforms of each other. On a dark surface brighter means more, so
 * both ramps climb toward white; on a light surface that reads backwards, so both descend
 * toward near-black instead.
 *
 * `bothWays` is indigo on light rather than blue because the light basemap draws rivers in
 * blue-grey and a hairline of #4a86cf was, measurably, the same feature. See SPEC.md section
 * 6.2 and run `npm run palette` after changing anything here.
 */
export const PALETTES: Record<Theme, Palette> = {
  dark: {
    heatmap: ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
    frontier: '#eda100',
    oneWay: ['#be4b1d', '#d15421', '#e15a24', '#f76730', '#f88d68', '#faac90'],
    bothWays: ['#256abf', '#3579cd', '#4a86cf', '#5598e7', '#79b0ef', '#9ec5f4'],
  },
  light: {
    heatmap: ['#5b52e8', '#4a34c9', '#3822a0', '#261577', '#170a4d'],
    frontier: '#c07a00',
    oneWay: ['#b5471b', '#a44017', '#8f3713', '#7d2f0f', '#6e280c', '#581e07'],
    bothWays: ['#5b52e8', '#5346d9', '#4a34c9', '#4029b4', '#3822a0', '#2b1a80'],
  },
};
