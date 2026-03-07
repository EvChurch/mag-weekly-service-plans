/**
 * utils.js - Shared date/key utilities
 */

/**
 * Returns the date string (YYYY-MM-DD) of the next Sunday (or today if it's Sunday).
 */
export function nextSundayDate() {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() + daysUntilSunday);
  return sunday.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Returns the KV key for a given Sunday date string.
 */
export function weekKey(sundayDate) {
  return `week:${sundayDate}`;
}
