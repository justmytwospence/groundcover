/**
 * @um/ledger - the GroundCover algorithm.
 *
 * PURE TYPESCRIPT. No node APIs, no third-party runtime dependencies, so this package runs
 * unchanged in a Node build script or a browser worker. All file I/O belongs to the caller.
 */

import { serialize } from './artifacts.js';
import { runLedger } from './ledger.js';
import { DEFAULT_PARAMS, type Params } from './params.js';
import type { LedgerInput, LedgerOutput } from './types.js';

export * from './geo.js';
export * from './params.js';
export * from './types.js';
export { excluded } from './preprocess.js';
export { runLedger, createBuilder, type LedgerBuilder, type Rejection } from './ledger.js';
export { serialize } from './artifacts.js';

/**
 * The single entry point. Sorts its input by (startTs, id) itself, so callers need not
 * pre-sort, and is a pure function of (input, params).
 */
export function buildLedger(input: LedgerInput[], params: Params = DEFAULT_PARAMS): LedgerOutput {
  return serialize(runLedger(input, params), params);
}
