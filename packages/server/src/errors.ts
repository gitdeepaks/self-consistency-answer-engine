/**
 * Error description lives in `@sce/shared` now that the worker needs it too —
 * the same thrown provider object has to read the same way whether it surfaces
 * on an HTTP response or on a candidate row written by a worker three machines
 * away.
 *
 * Re-exported rather than re-implemented so existing imports keep working and
 * there is exactly one definition of what a provider error looks like.
 */
export { describeError, errorFacts, type ErrorFacts } from "@sce/shared"
