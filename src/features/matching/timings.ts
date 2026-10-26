// Live matchmaking and booking timings (Decision 0011), in one place so a founder change is a
// one-line edit. Only the 30-second accept is founder-confirmed; the rest are proposed values.

/** Both players accept a queue match within this many seconds (founder-confirmed). */
export const OFFER_SECONDS = 30;
/** A waiting ticket leaves the queue after this long without presence. */
export const PRESENCE_SECONDS = 90;
/** Time to join a queue match before it is cancelled as a no-show. */
export const QUEUE_JOIN_SECONDS = 90;
/** Time to join a scheduled debate after its start before it is cancelled as a no-show. */
export const SCHEDULED_JOIN_SECONDS = 600;
/** The queue screen's camera and microphone check stays valid this long. */
export const DEVICE_CHECK_MINUTES = 30;
/** A scheduled debate's seat is held from this long before its start. */
export const BOOKING_LEAD_SECONDS = 300;
/** Used when the active rule version sets no maximum duration. */
export const DEFAULT_MAXIMUM_DURATION_SECONDS = 600;
/** An online target has this long to answer a "now" challenge before it waits as pending. */
export const NOW_RESPONSE_SECONDS = 120;
/** A player counts as online for "now" challenges when seen this recently. */
export const ONLINE_SECONDS = 60;
/** An unanswered challenge expires after this many days. */
export const CHALLENGE_PENDING_DAYS = 7;
/** Proposed times must be at least this far ahead (and at most 90 days). */
export const PROPOSAL_MIN_LEAD_MINUTES = 60;
/** At most this many open outgoing challenges per player. */
export const OPEN_CHALLENGES_LIMIT = 10;
/** Both speakers get an in-app reminder this long before a scheduled debate. */
export const REMINDER_MINUTES = 5;
