/**
 * Light and dark.
 *
 * Starts on whatever the operating system asks for and keeps following it until the user
 * expresses a preference of their own, after which it stays put. That distinction is the whole
 * behaviour: a machine that flips at sunset should carry the page with it, but someone who
 * deliberately chose light at midnight should not be overruled an hour later.
 */

import { useEffect } from 'react';
import { useStore } from '../state/store.js';
import {
  applyTheme,
  resolveTheme,
  saveChoice,
  watchSystemTheme,
  type ThemeChoice,
} from '../lib/theme.js';

/** Shows the state you are IN, not the one you would move to -- with three states, "next" is
 *  ambiguous and the icon stops being a label. */
const ICON: Record<ThemeChoice, string> = { system: '◐', light: '☀', dark: '☾' };
const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<ThemeChoice, string> = {
  system: 'following your system',
  light: 'light',
  dark: 'dark',
};

export function ThemeToggle({ floating = false }: { floating?: boolean } = {}) {
  const theme = useStore((s) => s.theme);
  const choice = useStore((s) => s.themeChoice);
  const set = useStore((s) => s.set);

  // Applied here rather than at module load so it stays in step with the store, which is the
  // single source of truth the worker also reads its palette selection from.
  useEffect(() => applyTheme(theme), [theme]);

  // Only meaningful while the choice is "system"; the guard lives here because only the store
  // knows that, and reading localStorage from the watcher would duplicate the decision.
  useEffect(
    () => watchSystemTheme((t) => { if (useStore.getState().themeChoice === 'system') set({ theme: t }); }),
    [set],
  );

  const next = NEXT[choice];

  return (
    <button
      className={`ghost theme-toggle${floating ? ' theme-toggle-floating' : ''}`}
      onClick={() => {
        saveChoice(next);
        set({ themeChoice: next, theme: resolveTheme(next) });
      }}
      title={`Theme: ${LABEL[choice]} — click for ${LABEL[next]}`}
      aria-label={`Theme: ${LABEL[choice]}. Click for ${LABEL[next]}.`}
    >
      <span aria-hidden>{ICON[choice]}</span>
    </button>
  );
}
