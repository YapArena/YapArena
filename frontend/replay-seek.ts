// Plays a debate's replay from a place in its recording, for the turn
// timeline and Results by turn (direction BC1's replay board). It only sets
// the replay video's position, or presses the page's own Play replay button
// first: the replay player keeps its loading, recovery and yap:playback.
/* global document */

/**
 * Seeks the replay video, keeping it playing or paused. Before the replay
 * has loaded, it presses Play replay and seeks once the recording's length
 * is known. False when the replay can't be played from here yet.
 */
export function seekReplay(seconds: number) {
  const section = document.querySelector<HTMLElement>("[data-media-event]");
  const video = section?.querySelector<HTMLVideoElement>(
    "[data-media-replay-video]",
  );
  if (!section || !video) return false;
  if (!video.hidden && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    video.currentTime = seconds;
    return true;
  }
  const start = section.querySelector<HTMLButtonElement>("[data-media-replay]");
  if (!start || start.hidden || start.disabled) return false;
  video.addEventListener(
    "loadedmetadata",
    () => {
      video.currentTime = seconds;
    },
    { once: true },
  );
  start.click();
  return true;
}
