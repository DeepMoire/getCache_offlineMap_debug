/**
 * bakeFlags — compile-time switches on WHAT a bake does, kept in one small
 * module so the debug report can print them without importing the bake
 * service (which would drag the whole engine into debugReport.ts and trip
 * debugReport.portability.test.ts).
 */

/**
 * 🔬 BISECT — per-pin fire refresh. `true` restores fires baking beside every
 * pin; `false` (current) means the Fires row is grey BY DESIGN, not broken.
 * Exported so the debug report prints the real value beside the Fires row
 * instead of a reader guessing why it never lights.
 */
export const FIRE_REFRESH_ENABLED = false;
