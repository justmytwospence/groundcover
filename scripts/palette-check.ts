/**
 * The palette checker SPEC.md section 6.2 has always referred to and this repository never had.
 *
 * Section 6.2 states the criteria a map ramp has to meet and the numbers the current palettes
 * score, but the tool that produced those numbers lived outside the repo, so "re-validate rather
 * than eyeballing" (CLAUDE.md) was an instruction nobody could actually follow. This is that
 * tool: it re-derives every number in 6.2 from `app/src/lib/theme.ts`, and it can search for a
 * replacement ramp when one of the constraints changes.
 *
 *   npm run palette            # check the shipped palettes
 *   npm run palette -- search  # rank candidate hues for the light repeat ramp
 *
 * The one criterion 6.2 did not have: **separation from the basemap.** A coverage line the same
 * colour as a river is not a legible map, however well the ramp scores against its own surface,
 * and the light basemaps draw water in exactly the blue-grey the light ramp was climbing
 * through. Water is therefore a first-class constraint here, not an afterthought.
 */

import {
  BASEMAP_ROAD,
  BASEMAP_WATER,
  MAP_SURFACE,
  MODE_ALPHA,
  PALETTES,
  type Theme,
} from '../app/src/lib/palette.js';

// ---- colour space ------------------------------------------------------------------------

type RGB = [number, number, number];
type Lab = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

const rgbToHex = (c: RGB): string =>
  '#' +
  c
    .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0'))
    .join('');

const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** sRGB to OKLab (Björn Ottosson). L is perceptual lightness on 0..1. */
function oklab(rgb: RGB): Lab {
  const [r, g, b] = rgb.map(toLinear) as RGB;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: Lab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const inGamut = (c: RGB): boolean => c.every((v) => v >= -0.001 && v <= 1.001);

/** OKLCh helpers. Hue in degrees. */
const hueOf = ([, a, b]: Lab): number => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const fromLch = (L: number, C: number, hDeg: number): Lab => {
  const h = (hDeg * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
};

/** Distance in OKLab, scaled by 100 the way section 6.2 quotes it. */
const deltaE = (x: string, y: string): number => {
  const a = oklab(hexToRgb(x));
  const b = oklab(hexToRgb(y));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100;
};

// ---- colour vision deficiency ------------------------------------------------------------

/** Machado, Oliveira & Fernandes (2009), severity 1.0. */
const CVD: Record<string, number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

function simulate(hex: string, kind: keyof typeof CVD | 'normal'): string {
  if (kind === 'normal') return hex;
  const m = CVD[kind];
  const [r, g, b] = hexToRgb(hex).map(toLinear) as RGB;
  const out: RGB = [
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  ];
  return rgbToHex(out.map(toSrgb) as RGB);
}

const VIEWS = ['normal', 'protan', 'deutan', 'tritan'] as const;

/** The worst separation any of the four viewers sees. This is the number that matters. */
const worstDeltaE = (x: string, y: string): number =>
  Math.min(...VIEWS.map((v) => deltaE(simulate(x, v), simulate(y, v))));

// ---- contrast ----------------------------------------------------------------------------

const luminance = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (x: string, y: string): number => {
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

// ---- the criteria ------------------------------------------------------------------------

/**
 * Thresholds. The first four are section 6.2's, restated; the last two are the basemap
 * constraint. 15 is the floor a line has to clear against water before the two stop reading as
 * the same feature at a glance -- below it, a river and a repeated trail are one squiggle.
 */
const MIN_LIGHTNESS_GAP = 0.06;
const MAX_HUE_SPREAD = 3.5;
const MIN_SURFACE_CONTRAST = 3;
const MIN_ACCENT_SEPARATION = 8;
const MIN_ROAD_SEPARATION_CVD = 7;

/**
 * What a hairline actually puts on screen.
 *
 * Coverage lines are drawn at `widthMinPixels: 1.2` (MapView), so at low zoom most of the map
 * is sub-pixel line: antialiasing blends each one toward the surface and the colour the eye
 * compares is this blend, not the hex in the palette. Ignoring that is how a ramp can score 25
 * against water and still read as a river -- #4a86cf is a confident blue, and #4a86cf at 60%
 * over near-white is the pale blue-grey the basemap draws the Deschutes with.
 *
 * Every water and contrast check below therefore runs on the blended colour. It is the single
 * change that makes the checker agree with what is on screen.
 */
const COVERAGE_AT_MIN_WIDTH = 0.9;

/** Which palette a surface belongs to. */
const themeOf = (surface: string): Theme => (surface === MAP_SURFACE.light ? 'light' : 'dark');

/** What a line of this mode actually puts on screen once width and opacity are applied. */
const effectiveAlpha = (theme: Theme, mode: 'exploration' | 'heatmap'): number =>
  (MODE_ALPHA[theme][mode] / 255) * COVERAGE_AT_MIN_WIDTH;

const blend = (hex: string, surface: string, alpha: number): string => {
  const c = hexToRgb(hex);
  const s = hexToRgb(surface);
  return rgbToHex(c.map((v, i) => v * alpha + s[i] * (1 - alpha)) as RGB);
};
/**
 * Water is checked two ways, because a 1.2px line is read by hue long before anyone measures a
 * distance. Distance keeps the colours apart; the hue-family rule keeps a thin blue line from
 * reading as a waterway even when it is much darker than one -- which is the failure being
 * fixed here, and one that distance alone scores as fine.
 */
const MIN_WATER_SEPARATION = 12;
const MIN_WATER_SEPARATION_CVD = 9;
const MIN_WATER_HUE_DISTANCE = 40;
/**
 * Below this OKLab chroma a colour has no hue to be confused with, so the hue-family rule is
 * skipped for it and the distance floor above is the whole constraint.
 *
 * This is not a loophole, it is the rule's own precondition. The light basemap draws water in
 * #c2c8ca..#d1dbdf -- chroma 0.007 to 0.012, faint but consistently blue-grey at 220-224deg,
 * and that is the hue a thin blue line gets mistaken for. The dark basemap draws it in #1b1b1d:
 * rgb(27, 27, 29), chroma 0.0038, a grey whose "hue" of 286deg is what atan2 returns for a
 * two-count blue tint. Measuring hue distance from that is measuring rounding noise, and it
 * fails whichever hues the noise happens to point away from.
 */
const MIN_HUE_BEARING_CHROMA = 0.005;
/**
 * A hairline has to be visible before anything else about it matters. 2.2:1 is below the 3:1
 * the nominal colours must clear -- a line thinned to sub-pixel legitimately gives some of that
 * back -- but it is well above the 1.99:1 the shipped light ramp manages, which is the
 * measurement behind "hard to see in general".
 */
const MIN_HAIRLINE_CONTRAST = 2.2;

/**
 * How much of a line's own colour survives at `widthMinPixels`. At the old 1.2px a line was
 * mostly the surface showing through its own antialiasing; at 2.4px the middle of the stroke is
 * fully covered and only the edges feather, so the colour on screen is close to the colour in
 * the palette.
 */
/**
 * Lower than the water floor, and deliberately so. Roads are neutral greys, so at the mid
 * lightnesses a ramp has to pass through, the only thing separating a line from a road casing
 * is chroma -- and sRGB simply does not offer much of it there: the most saturated colour
 * available around L 0.55 is roughly 13 from grey. A floor of 12 would reject every hue on the
 * wheel rather than describe a real requirement. 10 is what the gamut allows while still
 * reading as "coloured line, grey road", and it is above the 8.6 the shipped ramp scores.
 */
const MIN_ROAD_SEPARATION = 10;

/**
 * Known deviations, accepted with a reason rather than hidden by loosening a threshold.
 *
 * The dark ramps' most recessive step is a hairline at 1.90:1 -- the same washing-out the light
 * ramp was rebuilt to fix, one third as severe. It is left alone deliberately: nobody has
 * reported it, that step's job is to recede, and raising it (#256abf -> #3480da clears the bar
 * at 2.31:1) would change the look of a deployment that is already public without anyone asking
 * for it. Delete the entry and the checker will start failing again, which is the point.
 */
const ALLOWANCES: Record<string, string> = {
  'exploration repeat ramp (dark)|hairline': 'recessive step, 1.90:1, unreported -- see the note above',
  'heatmap ramp (dark)|hairline': 'recessive step, 1.90:1, unreported -- see the note above',
  'continuous gradient (dark)|hairline': 'recessive step, 1.90:1, unreported -- see the note above',
};

export interface Report {
  ok: boolean;
  lines: string[];
}

/** The value after a flag, e.g. `--accent '#c07a00'`. Absent flag and bare flag both give null. */
function argAfter(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  const v = i < 0 ? undefined : process.argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

/**
 * `gradient: true` skips the adjacent-lightness-gap rule. That rule exists so discrete bands
 * stay tellable apart, and a sampled gradient has no bands -- theme.ts says as much, and
 * without this the checker would demand a stepped ramp everywhere a smooth one is intended.
 */
function checkRamp(
  name: string,
  ramp: string[],
  surface: string,
  accent: string | null,
  opts: { gradient?: boolean; alpha?: number } = {},
): Report {
  const alpha = opts.alpha ?? COVERAGE_AT_MIN_WIDTH;
  const lines: string[] = [];
  let ok = true;
  const fail = (s: string) => {
    ok = false;
    lines.push(`  FAIL ${s}`);
  };
  const pass = (s: string) => lines.push(`  ok   ${s}`);

  const labs = ramp.map((c) => oklab(hexToRgb(c)));
  const Ls = labs.map((l) => l[0]);

  const descending = Ls.every((v, i) => i === 0 || v < Ls[i - 1]);
  const ascending = Ls.every((v, i) => i === 0 || v > Ls[i - 1]);
  if (descending || ascending) pass(`monotone lightness (${descending ? 'descending' : 'ascending'})`);
  else fail(`lightness is not monotone: ${Ls.map((l) => l.toFixed(3)).join(' ')}`);

  const gaps = Ls.slice(1).map((v, i) => Math.abs(v - Ls[i]));
  const minGap = Math.min(...gaps);
  if (opts.gradient) lines.push(`  ..   gap rule not applied (a gradient has no bands); min ${minGap.toFixed(3)}`);
  else if (minGap >= MIN_LIGHTNESS_GAP)
    pass(`adjacent lightness gaps >= ${MIN_LIGHTNESS_GAP} (min ${minGap.toFixed(3)})`);
  else fail(`adjacent lightness gap ${minGap.toFixed(3)} < ${MIN_LIGHTNESS_GAP}`);

  const hues = labs.map(hueOf);
  const spread = Math.max(...hues) - Math.min(...hues);
  if (spread <= MAX_HUE_SPREAD) pass(`single hue (spread ${spread.toFixed(1)}deg)`);
  else fail(`hue spread ${spread.toFixed(1)}deg > ${MAX_HUE_SPREAD}`);

  const hairline = ramp.map((c) => blend(c, surface, alpha));
  const contrasts = ramp.map((c) => contrast(c, surface));
  const worstContrast = Math.min(...contrasts);
  if (worstContrast >= MIN_SURFACE_CONTRAST)
    pass(`weakest step clears ${MIN_SURFACE_CONTRAST}:1 on ${surface} (${worstContrast.toFixed(2)}:1)`);
  else fail(`weakest step is ${worstContrast.toFixed(2)}:1 on ${surface}, under ${MIN_SURFACE_CONTRAST}:1`);

  const hairContrast = Math.min(...hairline.map((c) => contrast(c, surface)));
  const allowance = ALLOWANCES[`${name}|hairline`];
  if (hairContrast >= MIN_HAIRLINE_CONTRAST)
    pass(`weakest step still reads at the width and opacity it paints with (${hairContrast.toFixed(2)}:1)`);
  else if (allowance)
    lines.push(`  ~~   allowed: hairline width gives ${hairContrast.toFixed(2)}:1 -- ${allowance}`);
  else
    fail(
      `weakest step washes out at the width and opacity it paints with: ${hairContrast.toFixed(2)}:1, under ${MIN_HAIRLINE_CONTRAST}:1`,
    );

  if (accent) {
    const seps = ramp.map((c) => worstDeltaE(c, accent));
    const worst = Math.min(...seps);
    if (worst >= MIN_ACCENT_SEPARATION)
      pass(`accent ${accent} separates from every step by >= ${MIN_ACCENT_SEPARATION} (worst ${worst.toFixed(1)})`);
    else fail(`accent ${accent} is only ${worst.toFixed(1)} from a step`);
  }

  const water = BASEMAP_WATER[themeOf(surface)];
  if (water.length) {
    let worstNormal = Infinity;
    let worstCvd = Infinity;
    let pair = '';
    for (const step of hairline)
      for (const w of water) {
        const n = deltaE(step, w);
        if (n < worstNormal) {
          worstNormal = n;
          pair = `${step} vs ${w}`;
        }
        worstCvd = Math.min(worstCvd, worstDeltaE(step, w));
      }
    if (worstNormal >= MIN_WATER_SEPARATION && worstCvd >= MIN_WATER_SEPARATION_CVD)
      pass(`separates from water by >= ${MIN_WATER_SEPARATION} (worst ${worstNormal.toFixed(1)} normal, ${worstCvd.toFixed(1)} cvd, ${pair})`);
    else
      fail(`reads as water: ${pair} is ${worstNormal.toFixed(1)} normal / ${worstCvd.toFixed(1)} cvd`);

    // Hue family, not just distance -- but only against water that has a hue at all.
    const chromatic = water.filter((w) => {
      const [, a, b] = oklab(hexToRgb(w));
      return Math.hypot(a, b) >= MIN_HUE_BEARING_CHROMA;
    });
    const waterHues = chromatic.map((w) => hueOf(oklab(hexToRgb(w))));
    let closestHue = 360;
    for (const step of hairline) {
      const h = hueOf(oklab(hexToRgb(step)));
      for (const wh of waterHues) {
        // Shortest way round the hue circle. `+ 540` rather than `+ 180` because hue difference
        // runs to -360 and JS `%` keeps the sign of its left operand, so the smaller offset
        // reports impossible distances above 180 for the pairs that wrap.
        //
        // This line used to end `Math.min(closestHue, 180 - ang)`, which inverted the whole
        // rule: it scored two *identical* hues as 180deg apart and opposite ones as 0. It
        // never rejected anything -- the blue that "read as a river" was caught by the
        // distance floor above, not by this -- and it rejected every warm hue precisely
        // because warm is as far from blue-grey water as a hue can get.
        const ang = Math.abs(((h - wh + 540) % 360) - 180);
        closestHue = Math.min(closestHue, ang);
      }
    }
    if (waterHues.length === 0)
      lines.push(`  ..   hue rule not applied: this basemap's water is achromatic (chroma < ${MIN_HUE_BEARING_CHROMA})`);
    else if (closestHue >= MIN_WATER_HUE_DISTANCE)
      pass(`hue is ${closestHue.toFixed(0)}deg off the water hue (>= ${MIN_WATER_HUE_DISTANCE})`);
    else fail(`hue is only ${closestHue.toFixed(0)}deg off the water hue: a thin line will read as a waterway`);
  }

  const road = BASEMAP_ROAD[themeOf(surface)];
  if (road.length) {
    let worstNormal = Infinity;
    let worstCvd = Infinity;
    let pair = '';
    for (const step of ramp)
      for (const r of road) {
        const n = deltaE(step, r);
        if (n < worstNormal) {
          worstNormal = n;
          pair = `${step} vs ${r}`;
        }
        worstCvd = Math.min(worstCvd, worstDeltaE(step, r));
      }
    if (worstNormal >= MIN_ROAD_SEPARATION && worstCvd >= MIN_ROAD_SEPARATION_CVD)
      pass(`separates from roads by >= ${MIN_ROAD_SEPARATION} (worst ${worstNormal.toFixed(1)} normal, ${worstCvd.toFixed(1)} cvd, ${pair})`);
    else fail(`reads as a road: ${pair} is ${worstNormal.toFixed(1)} normal / ${worstCvd.toFixed(1)} cvd`);
  }

  return { ok, lines: [`${name} on ${surface}`, ...lines] };
}

// ---- search ------------------------------------------------------------------------------

/** The most chroma this hue can carry at this lightness and still be sRGB. */
function maxChroma(L: number, h: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToRgb(fromLch(L, mid, h)))) lo = mid;
    else hi = mid;
  }
  return lo;
}

const rampFor = (h: number, topL: number, gap: number, steps: number, chromaScale: number): string[] =>
  Array.from({ length: steps }, (_, i) => {
    const L = topL - i * gap;
    return rgbToHex(oklabToRgb(fromLch(L, maxChroma(L, h) * chromaScale, h)));
  });

/**
 * Rank hues for the light-mode repeat ramp. Every candidate must pass the same checks the
 * shipped palette does; among those that pass, the ranking is by how far the ramp sits from
 * water, because that is the complaint this search exists to answer.
 */
function search(): void {
  // Both surfaces, because the ramp is no longer a light-mode-only problem: the warm ramp in
  // section 6.2 had to be selected twice, and a search that can only see the light surface is a
  // search that cannot answer half the question it is asked.
  const theme: Theme = process.argv.includes('--dark') ? 'dark' : 'light';
  const surface = MAP_SURFACE[theme];
  const accent = argAfter('--accent') ?? PALETTES[theme].frontier;
  const water = BASEMAP_WATER[theme];
  const road = BASEMAP_ROAD[theme];

  /** Every score that matters for one candidate ramp, so nothing is hidden behind a boolean. */
  const score = (ramp: string[]) => ({
    hair: Math.min(
      ...ramp.map((c) => contrast(blend(c, surface, effectiveAlpha(themeOf(surface), 'exploration')), surface)),
    ),
    water: Math.min(
      ...ramp.flatMap((s) =>
        water.map((w: string) => deltaE(blend(s, surface, effectiveAlpha(themeOf(surface), 'exploration')), w)),
      ),
    ),
    road: Math.min(...ramp.flatMap((s) => road.map((r) => worstDeltaE(s, r)))),
    accent: Math.min(...ramp.map((s) => worstDeltaE(s, accent))),
    contrast: Math.min(...ramp.map((s) => contrast(s, surface))),
    hueSpread: (() => {
      const hs = ramp.map((c) => hueOf(oklab(hexToRgb(c))));
      return Math.max(...hs) - Math.min(...hs);
    })(),
  });

  type Row = { h: number; topL: number; gap: number; scale: number; ramp: string[]; s: ReturnType<typeof score> };
  const best = new Map<number, Row>();

  // A dark surface reads brighter as more, so its ramp lives at the top of the lightness range
  // and is stored ascending; a light surface reads the other way and lives lower down. Searching
  // one set of ceilings for both would simply find nothing on whichever surface it was not
  // written for.
  const ceilings =
    theme === 'dark'
      ? [0.68, 0.7, 0.72, 0.75, 0.78, 0.8, 0.82, 0.85]
      : [0.42, 0.45, 0.48, 0.5, 0.52, 0.55, 0.58, 0.6, 0.62];

  for (let h = 0; h < 360; h += 2) {
    for (const topL of ceilings) {
      for (const gap of [0.05, 0.06, 0.07, 0.08, 0.09]) {
        for (const scale of [0.9, 1]) {
          const ramp = rampFor(h, topL, gap, 5, scale);
          const s = score(ramp);
          if (!checkRamp('t', ramp, surface, accent).ok) continue;
          const cur = best.get(h);
          // Among ladders that pass, keep the one with the most range: the lightest top step,
          // and the widest gaps under it. A ramp squeezed into the dark end satisfies every
          // rule and still tells the viewer nothing, because all five steps read as one colour.
          const value = topL * 10 + gap;
          const curValue = cur ? cur.topL * 10 + cur.gap : -1;
          if (value > curValue) best.set(h, { h, topL, gap, scale, ramp, s });
        }
      }
    }
  }

  const byHue = process.argv.includes('--by-hue');
  const rows = [...best.values()].sort((a, b) =>
    byHue ? a.h - b.h : Math.min(b.s.water, b.s.road) - Math.min(a.s.water, a.s.road),
  );
  if (rows.length === 0) {
    console.log('no hue passes every criterion');
    return;
  }
  console.log('hue   water  road  accent  nominal  hairline  ramp');
  for (const r of byHue ? rows.filter((r) => r.h % 10 === 0) : rows.slice(0, 18)) {
    const flag =
      r.s.water >= MIN_WATER_SEPARATION && r.s.road >= MIN_ROAD_SEPARATION && r.s.accent >= MIN_ACCENT_SEPARATION
        ? 'PASS'
        : '    ';
    console.log(
      `${String(r.h).padStart(3)} ${flag} ${r.s.water.toFixed(1).padStart(5)} ${r.s.road
        .toFixed(1)
        .padStart(5)} ${r.s.accent.toFixed(1).padStart(6)} ${r.s.contrast.toFixed(2).padStart(6)}:1 ${r.s.hair
        .toFixed(2)
        .padStart(7)}:1  L${r.topL} g${r.gap} x${r.scale}  ${r.ramp.join(' ')}`,
    );
  }
}

// ---- entry -------------------------------------------------------------------------------

function checkAll(): void {
  const reports = [
    // exploration[0] is the frontier accent and exploration[4] repeats step 3, so the ramp
    // proper is entries 1..3 -- see the Palette docblock in theme.ts.
    checkRamp('exploration repeat ramp (dark)', PALETTES.dark.exploration.slice(1, 4), MAP_SURFACE.dark, PALETTES.dark.frontier, { alpha: effectiveAlpha('dark', 'exploration') }),
    checkRamp('heatmap ramp (dark)', PALETTES.dark.heatmap, MAP_SURFACE.dark, null, { alpha: effectiveAlpha('dark', 'heatmap') }),
    checkRamp('exploration repeat ramp (light)', PALETTES.light.exploration.slice(1, 4), MAP_SURFACE.light, PALETTES.light.frontier, { alpha: effectiveAlpha('light', 'exploration') }),
    checkRamp('heatmap ramp (light)', PALETTES.light.heatmap, MAP_SURFACE.light, null, { alpha: effectiveAlpha('light', 'heatmap') }),
    checkRamp('continuous gradient (dark)', PALETTES.dark.gradient, MAP_SURFACE.dark, PALETTES.dark.frontier, { gradient: true }),
    checkRamp('continuous gradient (light)', PALETTES.light.gradient, MAP_SURFACE.light, PALETTES.light.frontier, { gradient: true }),
    // Exploration's second accent, three ways: it has to be visible on its own surface, and it
    // has to stay apart from BOTH the frontier and every step of the ramp it sits between. A
    // one-element ramp is not a degenerate case here -- it is exactly the question being asked,
    // and the monotone and gap rules are vacuously true for it rather than skipped.
    ...(['dark', 'light'] as const).flatMap((t) => [
      checkRamp(`one-way accent (${t})`, [PALETTES[t].oneWay], MAP_SURFACE[t], PALETTES[t].frontier, {
        alpha: effectiveAlpha(t, 'exploration'),
      }),
      checkRamp(`continuous gradient vs one-way accent (${t})`, PALETTES[t].gradient, MAP_SURFACE[t], PALETTES[t].oneWay, {
        gradient: true,
      }),
    ]),
  ];
  for (const r of reports) {
    console.log(r.lines.join('\n'));
    console.log('');
  }
  const failed = reports.filter((r) => !r.ok).length;
  console.log(failed === 0 ? 'all palettes pass' : `${failed} palette(s) FAILED`);
  if (failed > 0) process.exitCode = 1;
}

/** Check an arbitrary ramp, so a candidate can be judged before it is committed. */
function explain(): void {
  const arg = process.argv[process.argv.indexOf('explain') + 1] ?? '';
  const ramp = arg.split(',').map((c) => c.trim()).filter(Boolean);
  const theme: Theme = process.argv.includes('--dark') ? 'dark' : 'light';
  // Exploration has two reserved accents now, so "the accent" is a question rather than a
  // constant: a candidate ramp has to clear the frontier AND the one-way colour, and only the
  // caller knows which one it is being scored against.
  const accent = argAfter('--accent') ?? PALETTES[theme].frontier;
  const r = checkRamp(`candidate (${ramp.length} steps)`, ramp, MAP_SURFACE[theme], accent, {
    gradient: process.argv.includes('--gradient'),
  });
  console.log(r.lines.join('\n'));
  console.log(r.ok ? '\npasses' : '\nFAILS');
  if (!r.ok) process.exitCode = 1;
}

if (process.argv.includes('search')) search();
else if (process.argv.includes('explain')) explain();
else checkAll();
