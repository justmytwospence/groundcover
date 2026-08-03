/**
 * zod schemas for the Strava wire formats. See docs/data-pipeline.md sections 3.1 and 3.2.
 *
 * Policy throughout: unknown fields are logged, never fatal. Strava adds fields without
 * notice, and a backfill that has already spent hours of API budget must not die because a
 * new key appeared.
 */

import { z } from 'zod';

/** A stream of scalars: `time` and `altitude`. */
const NumberStreamSchema = z
  .object({
    data: z.array(z.number()),
    series_type: z.string().optional(),
    original_size: z.number().optional(),
    resolution: z.string().optional(),
  })
  .passthrough();

/** A stream of [lat, lng] pairs. */
const LatLngStreamSchema = z
  .object({
    data: z.array(z.tuple([z.number(), z.number()])),
    series_type: z.string().optional(),
    original_size: z.number().optional(),
    resolution: z.string().optional(),
  })
  .passthrough();

/**
 * `GET /activities/{id}/streams?key_by_type=true` keys the response by stream type and omits
 * any stream the activity does not have. Every top-level key is therefore optional: a
 * treadmill run with heart rate returns HTTP 200 with no `latlng` at all.
 */
export const StreamSetSchema = z
  .object({
    latlng: LatLngStreamSchema.optional(),
    time: NumberStreamSchema.optional(),
    altitude: NumberStreamSchema.optional(),
  })
  .passthrough();

export const SummaryActivitySchema = z
  .object({
    id: z.number(),
    name: z.string(),
    sport_type: z.string(),
    /** UTC. startTs derives from this and never from start_date_local. */
    start_date: z.string(),
    start_date_local: z.string(),
    distance: z.number(),
    trainer: z.boolean(),
    manual: z.boolean(),
    /** [] for an activity with no GPS, null when Strava omits the fix entirely. */
    start_latlng: z.array(z.number()).nullable().optional(),
    has_heartrate: z.boolean().optional(),
    map: z
      .object({ summary_polyline: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type NumberStream = z.infer<typeof NumberStreamSchema>;
export type LatLngStream = z.infer<typeof LatLngStreamSchema>;
export type StreamSet = z.infer<typeof StreamSetSchema>;
export type SummaryActivity = z.infer<typeof SummaryActivitySchema>;

/**
 * Documented SummaryActivity fields as of the Strava v3 API. Anything outside this set is a
 * field Strava added since; it is kept by .passthrough() and reported once so the addition is
 * visible without spamming a 2,000-activity backfill.
 */
const KNOWN_ACTIVITY_KEYS: ReadonlySet<string> = new Set([
  'achievement_count',
  'athlete',
  'athlete_count',
  'average_cadence',
  'average_heartrate',
  'average_speed',
  'average_temp',
  'average_watts',
  'comment_count',
  'commute',
  'device_watts',
  'display_hide_heartrate_option',
  'distance',
  'elapsed_time',
  'elev_high',
  'elev_low',
  'end_latlng',
  'external_id',
  'flagged',
  'from_accepted_tag',
  'gear_id',
  'has_heartrate',
  'has_kudoed',
  'heartrate_opt_out',
  'hide_from_home',
  'id',
  'kilojoules',
  'kudos_count',
  'location_city',
  'location_country',
  'location_state',
  'manual',
  'map',
  'max_heartrate',
  'max_speed',
  'max_watts',
  'moving_time',
  'name',
  'photo_count',
  'pr_count',
  'private',
  'resource_state',
  'sport_type',
  'start_date',
  'start_date_local',
  'start_latlng',
  'suffer_score',
  'timezone',
  'total_elevation_gain',
  'total_photo_count',
  'trainer',
  'type',
  'upload_id',
  'upload_id_str',
  'utc_offset',
  'visibility',
  'weighted_average_watts',
  'workout_type',
]);

let reportedUnknownKeys = false;

/** Resets the once-per-run latch. Exists for the tests; a real run never calls it. */
export function resetUnknownKeyReport(): void {
  reportedUnknownKeys = false;
}

/**
 * Parses one raw activity, reporting fields Strava has added since this schema was written.
 * At most one report per process, per docs/data-pipeline.md section 3.1.
 */
export function parseSummaryActivity(raw: unknown): SummaryActivity {
  const activity = SummaryActivitySchema.parse(raw);
  if (!reportedUnknownKeys) {
    const unknown = Object.keys(activity).filter((k) => !KNOWN_ACTIVITY_KEYS.has(k));
    if (unknown.length > 0) {
      reportedUnknownKeys = true;
      console.warn(`strava: unrecognized SummaryActivity fields: ${unknown.sort().join(', ')}`);
    }
  }
  return activity;
}
