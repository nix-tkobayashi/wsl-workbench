// When to look for a newer release while the app keeps running (not only at startup): at most once
// per MIN_GAP_MS when a window gains focus, and at least every PERIOD_MS in the background. Kept
// well under GitHub's unauthenticated API limit (60 requests / hour / IP). Pure; unit-tested.

const { isNewer } = require('./version');

const PERIOD_MS = 60 * 60 * 1000;   // background re-check
const MIN_GAP_MS = 15 * 60 * 1000;  // focus-triggered re-check throttle

function shouldCheck({ now, lastCheckAt, inFlight, reason }) {
  if (inFlight) return false;
  if (reason !== 'focus' || lastCheckAt == null) return true; // startup and the hourly timer always run
  const gap = now - lastCheckAt;
  if (gap < 0) return true; // clock moved back: re-check rather than wait for the old time
  return gap >= MIN_GAP_MS;
}

// Whether a fetched release should light the toolbar "update available" button: it must be newer
// than the running app and than the release already announced (so a repeat find is a no-op). Used
// by the background checks and by the About dialog, which fetches the latest release itself.
function shouldAnnounce({ latest, current, announced }) {
  if (!latest || !isNewer(latest, current)) return false;
  return !announced || isNewer(latest, announced);
}

module.exports = { shouldAnnounce, shouldCheck, PERIOD_MS, MIN_GAP_MS };
