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
    exploration: ['#c07a00', '#4a86cf', '#245f9e', '#0f3557', '#0f3557'],
    heatmap: ['#4a86cf', '#3372b5', '#245f9e', '#164679', '#092c52'],
    frontier: '#c07a00',
    gradient: ['#4a86cf', '#3d78bd', '#2f6aa8', '#245f9e', '#164679', '#0f3557'],
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

/** The basemap that goes with each surface. */
export const BASEMAP_STYLE: Record<Theme, string> = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
};

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
