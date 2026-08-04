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
import { applyTheme, saveTheme, watchSystemTheme, type Theme } from '../lib/theme.js';

const ICON: Record<Theme, string> = { dark: '☾', light: '☀' };

export function ThemeToggle() {
  const theme = useStore((s) => s.theme);
  const set = useStore((s) => s.set);

  // Applied here rather than at module load so it stays in step with the store, which is the
  // single source of truth the worker also reads its palette selection from.
  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => watchSystemTheme((t) => set({ theme: t })), [set]);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      className="ghost theme-toggle"
      onClick={() => {
        saveTheme(next);
        set({ theme: next });
      }}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      <span aria-hidden>{ICON[next]}</span>
    </button>
  );
}
