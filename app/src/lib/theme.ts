/**
 * Light and dark, as a real choice rather than an inverted stylesheet.
 *
 * The two palettes are not transforms of each other. On a dark surface brighter means more, so
 * the repeat ramp climbs toward white; on a light surface that reads backwards, so it descends
 * toward navy instead. The frontier gold likewise has to darken (#eda100 sits at 1.9:1 on a
 * light map -- a hairline nobody would see), and its replacement had to be re-checked for
 * colour-vision separation against every step of the new ramp, not assumed.
 *
 * Both sets were run through the palette validator in SPEC.md section 6.2. Change a value here
 * or in theme.css and re-run it; do not eyeball the result.
 */

export type Theme = 'dark' | 'light';

/**
 * What the user asked for, as distinct from what is currently on screen.
 *
 * "system" is a real state rather than merely the absence of a choice. Without it, the first
 * click on the toggle silently pinned the theme forever -- following the operating system was
 * the default but there was no way back to it.
 */
export type ThemeChoice = 'system' | Theme;

const KEY = 'um.theme';

/** RGB triples the map worker paints with, parallel to the CSS custom properties. */
export interface Palette {
  exploration: string[];
  heatmap: string[];
  /** Reserved accent for ground covered exactly once. */
  frontier: string;
  /**
   * Continuous ramp for repeat visits, sampled rather than banded, and rescaled each query to
   * whatever the busiest visible ground actually is.
   *
   * Ends validated against their own surface: monotone lightness, a single hue (3 degrees on
   * dark, 5 on light), and the pale end clearing 3:1 -- 3.06:1 dark, 3.40:1 light. The
   * adjacent-lightness-gap rule is deliberately not applied: it exists so discrete bands stay
   * telling apart, and a gradient has no bands to tell apart.
   *
   * The frontier stays a separate reserved colour rather than becoming the ramp's first stop.
   * A gold-to-blue ramp cannot be monotone in lightness on a dark surface -- gold sits near the
   * top of the blue range, so hue and magnitude end up fighting -- and a ramp you cannot read
   * by brightness is not a ramp.
   */
  gradient: string[];
}

/**
 * Exploration: a reserved accent for ground visited exactly once, then a single-hue ordinal
 * ramp for depth. The last entry repeats the top step because the band function has one more
 * band than the ramp has distinct steps.
 */
export const PALETTES: Record<Theme, Palette> = {
  dark: {
    exploration: ['#eda100', '#256abf', '#5598e7', '#9ec5f4', '#9ec5f4'],
    heatmap: ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
    frontier: '#eda100',
    gradient: ['#256abf', '#3579cd', '#4a86cf', '#5598e7', '#79b0ef', '#9ec5f4'],
  },
  light: {
    exploration: ['#c07a00', '#5b52e8', '#3822a0', '#1c0f5e', '#1c0f5e'],
    heatmap: ['#5b52e8', '#4a34c9', '#3822a0', '#261577', '#170a4d'],
    frontier: '#c07a00',
    gradient: ['#5b52e8', '#5346d9', '#4a34c9', '#4029b4', '#3822a0', '#2b1a80'],
  },
};

/**
 * Free public elevation tiles from AWS Open Data, in Mapzen's "terrarium" encoding.
 *
 * This is a third party, and the honest consequence is that enabling hillshading tells Amazon
 * roughly where on the map you are looking -- the same disclosure the basemap already makes to
 * OpenFreeMap, but to one more party. No activity data is involved either way: a tile request
 * carries a zoom level and two tile indices and nothing else. It is off by default and behind a
 * checkbox for exactly that reason.
 */
export const TERRAIN_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * The basemaps that go with each surface, best first.
 *
 * A list rather than one URL because a basemap is the one part of this app that depends on
 * somebody else's server staying up, and when it does not the map becomes a flat field with
 * routes floating on it -- which reads as "this is broken" rather than "the tiles are late".
 * Two independent hosts, both free and key-less, both Positron-family so the palette in
 * section 6.2 holds either way. MapView walks the list and only settles for a blank background
 * when every entry has failed.
 */
export const BASEMAP_STYLES: Record<Theme, readonly string[]> = {
  dark: [
    'https://tiles.openfreemap.org/styles/dark',
    'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  ],
  light: [
    'https://tiles.openfreemap.org/styles/positron',
    'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  ],
};

/** Every basemap host, for the connect-src of both deployments. Keep the CSPs in step. */
export const BASEMAP_HOSTS = ['https://tiles.openfreemap.org', 'https://*.cartocdn.com'];

export function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * The choice to start from: an explicit past one, else follow the system.
 *
 * Deliberately NOT carried in the URL hash. The hash is for what you are looking at -- window,
 * filters, time range -- and a shared link should show the recipient their own preferred
 * surface, not impose the sender's.
 */
export function initialChoice(): ThemeChoice {
  const saved = localStorage.getItem(KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function resolveTheme(choice: ThemeChoice): Theme {
  return choice === 'system' ? systemTheme() : choice;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // Keeps form controls, scrollbars and the browser's own chrome in step with the page.
  document.documentElement.style.colorScheme = theme;
}

/** Storing nothing is how "follow the system" is represented, so choosing it clears the key. */
export function saveChoice(choice: ThemeChoice): void {
  if (choice === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
}

/**
 * Report system changes. The caller decides whether they matter, because only it knows whether
 * the current choice is "system" -- a machine that flips to dark at sunset should carry the page
 * with it, but someone who explicitly picked light should be left alone.
 */
export function watchSystemTheme(onChange: (t: Theme) => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: light)');
  if (!mq) return () => {};
  const handler = () => onChange(mq.matches ? 'light' : 'dark');
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
