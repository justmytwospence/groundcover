/**
 * The stream corpus, packed into a handful of blobs instead of one blob per activity.
 *
 * The cron rebuild is a FULL rebuild (see scripts/build-ledger.ts), so every run has to read
 * every stream. Reading them as 1,300+ individual objects would cost 1,300+ blob operations
 * against a 1,200/minute ceiling -- over a minute of the 300 s function budget spent on nothing
 * but round trips, growing every year. Sharding by calendar year turns that into ~8 reads, and
 * a run that adds activities rewrites only the shards those activities fall in.
 *
 * A shard holds the gzip bytes of each stream VERBATIM -- byte for byte what `npm run sync`
 * wrote to data/streams/{id}.json.gz. Seeding is a copy, not a re-encode, so the corpus in the
 * cloud cannot drift from the one on disk through some serialisation detail.
 *
 *   magic    4 bytes  'GCS1'
 *   count    u32le    entries in this shard
 *   indexLen u32le    byte length of the index
 *   index    JSON     [[id, offset, length], ...]  offsets relative to the payload
 *   payload           concatenated gzip members
 */

export const SHARD_MAGIC = 'GCS1';

export interface PackEntry {
  id: number;
  /** The gzip bytes exactly as `npm run sync` wrote them. */
  gz: Uint8Array;
}

const HEADER_BYTES = 12;

/** The shard an activity belongs to, keyed by the UTC year of its start. */
export function shardFor(startTs: number): string {
  return String(new Date(startTs * 1000).getUTCFullYear());
}

export function shardPath(shard: string): string {
  return `streams/${shard}.pack`;
}

export function encodePack(entries: PackEntry[]): Uint8Array {
  const index: [number, number, number][] = [];
  let offset = 0;
  for (const e of entries) {
    index.push([e.id, offset, e.gz.length]);
    offset += e.gz.length;
  }

  const indexBytes = new TextEncoder().encode(JSON.stringify(index));
  const out = new Uint8Array(HEADER_BYTES + indexBytes.length + offset);
  const view = new DataView(out.buffer);

  for (let i = 0; i < 4; i++) out[i] = SHARD_MAGIC.charCodeAt(i);
  view.setUint32(4, entries.length, true);
  view.setUint32(8, indexBytes.length, true);
  out.set(indexBytes, HEADER_BYTES);

  const payloadAt = HEADER_BYTES + indexBytes.length;
  for (let i = 0; i < entries.length; i++) out.set(entries[i].gz, payloadAt + index[i][1]);
  return out;
}

export function decodePack(buf: Uint8Array): PackEntry[] {
  if (buf.length < HEADER_BYTES) throw new Error('stream shard truncated: shorter than a header');
  for (let i = 0; i < 4; i++) {
    if (buf[i] !== SHARD_MAGIC.charCodeAt(i)) throw new Error('stream shard has a bad magic');
  }

  // byteOffset matters: a Uint8Array handed back by fetch is usually a view into a larger
  // buffer, and reading the DataView from offset 0 of that buffer would decode another
  // shard's header entirely.
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const indexLen = view.getUint32(8, true);
  const payloadAt = HEADER_BYTES + indexLen;
  if (payloadAt > buf.length) throw new Error('stream shard truncated: index overruns the blob');

  const index = JSON.parse(
    new TextDecoder().decode(buf.subarray(HEADER_BYTES, payloadAt)),
  ) as [number, number, number][];

  return index.map(([id, off, len]) => {
    const from = payloadAt + off;
    if (from + len > buf.length) throw new Error(`stream shard truncated at entry ${id}`);
    return { id, gz: buf.subarray(from, from + len) };
  });
}
