/**
 * Activity summary paging. See docs/data-pipeline.md section 3.1.
 *
 * Yields raw pages; validation is the caller's job, so one bad activity does not abort a crawl
 * that has already cost API budget.
 */

import { stravaGet } from './client.js';

export interface PageActivitiesOptions {
  accessToken: string;
  /** Unix seconds. Only activities started after this are returned. */
  after?: number;
  perPage?: number;
  /** Milliseconds of pacing between requests. */
  pace?: number;
}

const DEFAULT_PER_PAGE = 200;
const DEFAULT_PACE_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* pageActivities(opts: PageActivitiesOptions): AsyncGenerator<unknown[]> {
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const pace = opts.pace ?? DEFAULT_PACE_MS;

  for (let page = 1; ; page++) {
    if (page > 1 && pace > 0) await sleep(pace);

    const { data } = await stravaGet<unknown[]>('/athlete/activities', {
      accessToken: opts.accessToken,
      query: { per_page: perPage, page, after: opts.after },
    });
    if (!Array.isArray(data)) {
      throw new Error('Strava returned a non-array page from /athlete/activities');
    }

    if (data.length > 0) yield data;
    // A short page is the end of the history; Strava has no cursor or total count.
    if (data.length < perPage) return;
  }
}
