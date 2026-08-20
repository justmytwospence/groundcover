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

export type { Theme } from './palette.js';
import type { Theme } from './palette.js';

/**
 * What the user asked for, as distinct from what is currently on screen.
 *
 * "system" is a real state rather than merely the absence of a choice. Without it, the first
 * click on the toggle silently pinned the theme forever -- following the operating system was
 * the default but there was no way back to it.
 */
export type ThemeChoice = 'system' | Theme;

const KEY = 'um.theme';

export type { Palette } from './palette.js';
export { MAP_SURFACE, MODE_ALPHA, PALETTES } from './palette.js';

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
