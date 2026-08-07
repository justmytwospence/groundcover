/**
 * The stream shard format.
 *
 * This is the only place in the publish pipeline where GPS is re-encoded rather than copied, so
 * it is the only place a silent corruption could enter and survive all the way to a published
 * map. Byte-exactness is the property under test, not merely "it round-trips".
 */

import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';

import { decodePack, encodePack, shardFor, shardPath, type PackEntry } from '../pack.js';

function entry(id: number, payload: string): PackEntry {
  return { id, gz: new Uint8Array(gzipSync(Buffer.from(payload))) };
}

describe('encodePack / decodePack', () => {
  it('returns every entry byte for byte', () => {
    const entries = [entry(1, 'alpha'), entry(22, 'beta'), entry(333, 'x'.repeat(5000))];
    const decoded = decodePack(encodePack(entries));

    expect(decoded.map((e) => e.id)).toEqual([1, 22, 333]);
    for (let i = 0; i < entries.length; i++) {
      expect(Array.from(decoded[i].gz)).toEqual(Array.from(entries[i].gz));
    }
  });

  it('keeps the payloads gunzippable, which is what the rebuild actually needs', () => {
    const decoded = decodePack(encodePack([entry(7, '{"latlng":[[1,2]]}')]));
    expect(gunzipSync(Buffer.from(decoded[0].gz)).toString('utf8')).toBe('{"latlng":[[1,2]]}');
  });

  it('handles an empty shard', () => {
    expect(decodePack(encodePack([]))).toEqual([]);
  });

  /**
   * The regression this guards: a Uint8Array handed back by fetch is normally a VIEW into a
   * larger buffer. Reading the header via `new DataView(buf.buffer)` instead of honouring
   * byteOffset would decode from the wrong place -- and because the magic bytes would also be
   * read from the wrong place, it would fail loudly here rather than mis-slicing GPS.
   */
  it('decodes correctly when the shard is a view into a larger buffer', () => {
    const packed = encodePack([entry(11, 'first'), entry(12, 'second')]);
    const padded = new Uint8Array(packed.length + 64);
    padded.set(packed, 17);
    const view = padded.subarray(17, 17 + packed.length);

    const decoded = decodePack(view);
    expect(decoded.map((e) => e.id)).toEqual([11, 12]);
    expect(gunzipSync(Buffer.from(decoded[1].gz)).toString('utf8')).toBe('second');
  });

  it('rejects a blob that is not a shard rather than returning nonsense', () => {
    expect(() => decodePack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(
      /bad magic/,
    );
  });

  it('rejects a truncated shard', () => {
    const packed = encodePack([entry(1, 'alpha')]);
    expect(() => decodePack(packed.subarray(0, packed.length - 3))).toThrow(/truncated/);
  });
});

describe('shardFor', () => {
  it('shards on the UTC year of the activity start', () => {
    expect(shardFor(Date.UTC(2021, 5, 2) / 1000)).toBe('2021');
    expect(shardPath(shardFor(Date.UTC(2021, 5, 2) / 1000))).toBe('streams/2021.pack');
  });

  /**
   * Sharding must depend only on startTs, never on local time: the cron function runs in UTC
   * on Vercel and the seed runs in the owner's zone, and the two must agree on where an
   * activity lives or a re-seed would silently duplicate it into a second shard.
   */
  it('does not depend on the machine timezone', () => {
    const newYearUtc = Date.UTC(2022, 0, 1, 0, 30) / 1000;
    expect(shardFor(newYearUtc)).toBe('2022');
  });
});
