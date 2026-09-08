// Conservative sequential bound, even when the burst executor uses more VUs.
export const POLL_SECONDS = 240;
export const CREATE_HTTP_SECONDS = 15;
export const POLL_HTTP_SECONDS = 10;
export const POLL_INTERVAL_SECONDS = 2;
export const CANCEL_HTTP_SECONDS = 10;
export const THINK_SECONDS = 5;
export const ITERATION_SECONDS = CREATE_HTTP_SECONDS + POLL_SECONDS + POLL_HTTP_SECONDS +
  POLL_INTERVAL_SECONDS + CANCEL_HTTP_SECONDS + THINK_SECONDS + 15;
export const scenarioDuration = runs => `${runs * ITERATION_SECONDS + 60}s`;
