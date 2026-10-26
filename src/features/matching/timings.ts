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
