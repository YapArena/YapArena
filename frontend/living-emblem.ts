// The landing's living emblem anywhere else on the site (docs/site-design.md):
// every [data-living-emblem] holds the emblem image and its three canvases. The
// renderer (frontend/pixel-emblem.ts) rests in a hidden tab and with reduced
// motion; this also rests it while it is off screen.
import { createLivingEmblem } from "./pixel-emblem.js";

for (const stage of document.querySelectorAll<HTMLElement>(
  "[data-living-emblem]",
)) {
  const logo = stage.querySelector<HTMLImageElement>("img");
  const cores = stage.querySelector<HTMLCanvasElement>(".cores");
  const bloom = stage.querySelector<HTMLCanvasElement>(".bloom");
  const aura = stage.querySelector<HTMLCanvasElement>(".aura");
  if (!logo || !cores || !bloom || !aura) continue;
  const emblem = createLivingEmblem(stage, { logo, cores, bloom, aura });
  if ("IntersectionObserver" in window)
    new IntersectionObserver(([entry]) =>
      emblem.setActive(Boolean(entry?.isIntersecting)),
    ).observe(stage);
}
