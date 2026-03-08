/**
 * utils.js - Shared date/key utilities
 */

/**
 * Returns the date string (YYYY-MM-DD) of the next Sunday in NZ time.
 * Always returns the *upcoming* Sunday — never today, even if today is Sunday,
 * because service plans posted on Sunday are for the following week's service.
 */
export function nextSundayDate() {
  const now = new Date();

  // Determine today's date and weekday in NZ time (handles NZDT/NZST automatically)
  const nzDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // YYYY-MM-DD

  const nzWeekday = new Intl.DateTimeFormat('en', {
    timeZone: 'Pacific/Auckland',
    weekday: 'short',
  }).format(now); // 'Sun', 'Mon', ...

  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(nzWeekday);
  const daysUntilSunday = day === 0 ? 7 : 7 - day;

  const [y, m, d] = nzDate.split('-').map(Number);
  const sunday = new Date(Date.UTC(y, m - 1, d + daysUntilSunday));
  return sunday.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Returns the KV key for a given Sunday date string and campus name.
 * Key format: week:YYYY-MM-DD:CAMPUS_NAME
 */
export function weekKey(sundayDate, campusName) {
  return campusName ? `week:${sundayDate}:${campusName}` : `week:${sundayDate}`;
}
