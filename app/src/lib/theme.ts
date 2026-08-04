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

const KEY = 'um.theme';

/** RGB triples the map worker paints with, parallel to the CSS custom properties. */
export interface Palette {
  exploration: string[];
  heatmap: string[];
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
  },
  light: {
    exploration: ['#c07a00', '#4a86cf', '#245f9e', '#0f3557', '#0f3557'],
    heatmap: ['#4a86cf', '#3372b5', '#245f9e', '#164679', '#092c52'],
  },
};

/** The basemap that goes with each surface. */
export const BASEMAP_STYLE: Record<Theme, string> = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
};

function systemPreference(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * The theme to start in: an explicit past choice, else whatever the operating system asks for.
 *
 * Deliberately NOT carried in the URL hash. The hash is for what you are looking at -- window,
 * filters, time range -- and a shared link should show the recipient their own preferred
 * surface, not impose the sender's.
 */
export function initialTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  return saved === 'light' || saved === 'dark' ? saved : systemPreference();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // Keeps form controls, scrollbars and the browser's own chrome in step with the page.
  document.documentElement.style.colorScheme = theme;
}

export function saveTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
}

/**
 * Follow the system while the user has expressed no preference of their own.
 *
 * Someone whose machine flips to dark at sunset expects this to follow; someone who has
 * explicitly chosen expects to be left alone. Returns an unsubscribe.
 */
export function watchSystemTheme(onChange: (t: Theme) => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: light)');
  if (!mq) return () => {};
  const handler = () => {
    if (localStorage.getItem(KEY)) return;
    onChange(mq.matches ? 'light' : 'dark');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
