// Decision 0016 D9: on a phone replay the only control is a centred pause and
// play key. It replaces the native video controls while it is mounted. When
// it shows is the full screen's business (it comes and goes with the other
// tap controls, and a live debate never shows it); this module owns what it
// does and says.

export const PAUSE_LABEL = "Pause replay";
export const PLAY_LABEL = "Play replay";

export type PauseKeyState = "playing" | "paused";

/** Whether the key pauses (the replay is playing) or plays, and its label. */
export function pauseKeyView(video: { paused: boolean; ended: boolean }): {
  state: PauseKeyState;
  label: string;
} {
  return !video.paused && !video.ended
    ? { state: "playing", label: PAUSE_LABEL }
    : { state: "paused", label: PLAY_LABEL };
}

export interface PauseKeyOptions {
  /**
   * Starts playback; `video.play()` by default. A refused start (no sound
   * allowed yet, say) leaves the key on Play.
   */
  play?: () => Promise<unknown>;
}

/**
 * Makes `button` pause and play `video`, following the video's own state,
 * and returns the function that unmounts it and gives the video its native
 * controls back if it had them.
 */
export function mountPauseKey(
  button: HTMLButtonElement,
  video: HTMLVideoElement,
  { play = () => video.play() }: PauseKeyOptions = {},
): () => void {
  const hadControls = video.controls;
  video.controls = false;

  function render() {
    const view = pauseKeyView(video);
    button.dataset.replayState = view.state;
    button.setAttribute("aria-label", view.label);
  }

  function press(event: Event) {
    // The key sits on the picture, where a tap shows or hides the controls;
    // pausing keeps them as they are.
    event.stopPropagation();
    if (pauseKeyView(video).state === "playing") video.pause();
    else void play().catch(render);
  }

  const events = ["play", "playing", "pause", "ended", "emptied"];
  for (const type of events) video.addEventListener(type, render);
  button.addEventListener("click", press);
  render();

  let mounted = true;
  return function unmount() {
    if (!mounted) return;
    mounted = false;
    for (const type of events) video.removeEventListener(type, render);
    button.removeEventListener("click", press);
    if (hadControls) video.controls = true;
  };
}
