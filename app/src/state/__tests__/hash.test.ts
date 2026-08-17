/**
 * The hash is user-editable text arriving from a stranger's paste, so the parser is the one
 * part of the URL layer worth testing directly: everything it lets through lands in the store
 * unvalidated, and a bad value there shows up as a blank map with no error anywhere.
 */

import { describe, expect, it } from 'vitest';
import { parseHash } from '../hash.js';

const JAN_1_2023 = 1672531200;

describe('parseHash', () => {
  it('reads a time frame in unix seconds', () => {
    const { view } = parseHash('#t0=1672531200&t1=1704067200');
    expect(view.t0).toBe(JAN_1_2023);
    expect(view.t1).toBe(1704067200);
  });

  it('accepts ISO dates, so a time frame can be composed by hand', () => {
    const { view } = parseHash('#t0=2023-01-01&t1=2024-01-01');
    expect(view.t0).toBe(JAN_1_2023);
    expect(view.t1).toBe(1704067200);
  });

  it('reads a bare date as midnight UTC, matching how startTs is derived', () => {
    expect(parseHash('#t0=2023-01-01').view.t0).toBe(
      parseHash('#t0=2023-01-01T00:00:00Z').view.t0,
    );
  });

  it('orders the window, so a link with the ends swapped still selects something', () => {
    const { view } = parseHash('#t0=2024-01-01&t1=2023-01-01');
    expect(view.t0).toBe(JAN_1_2023);
    expect(view.t1).toBe(1704067200);
  });

  it('drops a time that is not a number instead of passing NaN to the store', () => {
    const { view } = parseHash('#t0=lunchtime&t1=1704067200');
    expect(view.t0).toBeUndefined();
    expect(view.t1).toBe(1704067200);
  });

  it('reads exact bounds, ordering the corners', () => {
    const { camera } = parseHash('#b=-105.3,39.6,-104.9,40.1');
    expect(camera).toEqual({ kind: 'bounds', bounds: [-105.3, 39.6, -104.9, 40.1] });
    expect(parseHash('#b=-104.9,40.1,-105.3,39.6').camera).toEqual(camera);
  });

  it('still honours the legacy centre/zoom camera', () => {
    expect(parseHash('#map=-105.1,39.8,11.5').camera).toEqual({
      kind: 'center',
      center: [-105.1, 39.8],
      zoom: 11.5,
    });
  });

  it('prefers exact bounds over a legacy camera in the same link', () => {
    expect(parseHash('#b=-105.3,39.6,-104.9,40.1&map=0,0,3').camera?.kind).toBe('bounds');
  });

  it('reports no camera when there is none, which is what makes the map fit the time frame', () => {
    expect(parseHash('#t0=2023-01-01&t1=2024-01-01').camera).toBeNull();
    expect(parseHash('').camera).toBeNull();
  });

  it('ignores a malformed camera rather than framing NaN', () => {
    expect(parseHash('#b=-105.3,39.6,-104.9').camera).toBeNull();
    expect(parseHash('#b=a,b,c,d').camera).toBeNull();
    expect(parseHash('#map=-105.1,39.8').camera).toBeNull();
  });

  it('keeps only real sport groups, and never an empty set', () => {
    expect(parseHash('#g=0,2,2,9,-1,x').view.groups).toEqual([0, 2]);
    expect(parseHash('#g=9').view.groups).toBeUndefined();
  });

  it('reads the flag options it writes, and ignores anything else', () => {
    const { view } = parseHash('#m=heatmap&vp=1&fit=1&fitplay=1&noskip=1&inview=1&u=km&d=1');
    expect(view).toMatchObject({
      mode: 'heatmap',
      viewportFilter: true,
      fitToSelection: true,
      fitWhilePlaying: true,
      skipEmptyDays: false,
      skipOutsideBounds: true,
      units: 'km',
      drawerOpen: true,
    });
    expect(parseHash('#m=nonsense&u=furlongs').view).toEqual({});
  });
});
