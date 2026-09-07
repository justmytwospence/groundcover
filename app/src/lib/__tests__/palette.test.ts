/**
 * Guards against the failure that made a validated palette change invisible: the colours the
 * map actually paints living somewhere other than lib/palette.ts.
 *
 * The query worker used to hold a private copy of every ramp. It was the copy that painted the
 * map, so editing `PALETTES` and the CSS tokens changed the legend, passed the checker, and
 * left the map exactly as it was. Nothing caught it because nothing was looking.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PALETTES, type Theme } from '../palette.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('palette is defined in exactly one place', () => {
  it('the query worker paints from lib/palette.ts, never its own hexes', () => {
    const src = read('../../worker/query.worker.ts');
    const hexes = src.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hexes).toEqual([]);
  });

  it('the CSS custom properties match the palette the worker paints with', () => {
    // theme.css cannot import TypeScript, so this pairing is the one duplication that has to
    // stay. It is checked rather than trusted.
    const css = read('../../theme.css');
    const tokenValue = (block: string, name: string): string | null =>
      block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]?.toLowerCase() ?? null;

    const lightBlock = css.slice(css.indexOf(":root[data-theme='light']"));
    const darkBlock = css.slice(css.indexOf(':root {'), css.indexOf(":root[data-theme='light']"));

    const cases: Array<[Theme, string, string[]]> = [
      ['dark', darkBlock, PALETTES.dark.heatmap],
      ['light', lightBlock, PALETTES.light.heatmap],
    ];

    for (const [theme, block, heat] of cases) {
      expect(tokenValue(block, 'frontier'), `${theme} --frontier`).toBe(
        PALETTES[theme].frontier.toLowerCase(),
      );
      expect(tokenValue(block, 'one-way'), `${theme} --one-way`).toBe(
        PALETTES[theme].oneWay.toLowerCase(),
      );
      heat.forEach((hex, i) => {
        expect(tokenValue(block, `heat-${i + 1}`), `${theme} --heat-${i + 1}`).toBe(hex.toLowerCase());
      });
      // exploration[0] is the frontier; 1..3 are the banded repeat steps.
      PALETTES[theme].exploration.slice(1, 4).forEach((hex, i) => {
        expect(tokenValue(block, `repeat-${i + 1}`), `${theme} --repeat-${i + 1}`).toBe(
          hex.toLowerCase(),
        );
      });
    }
  });
});
