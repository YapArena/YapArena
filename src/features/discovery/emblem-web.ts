// The landing's living emblem anywhere on the site: the image at rest and the
// three canvases frontend/living-emblem.ts lights (docs/site-design.md).
import { asset } from "./assets.ts";
import { html } from "../../platform/html.ts";

export const livingEmblem = () =>
  html`<div class="living-emblem" data-living-emblem aria-hidden="true"><canvas class="aura"></canvas><img src="${asset("landing/yaparena-emblem.png")}" width="2048" height="1715" alt=""><canvas class="bloom"></canvas><canvas class="cores"></canvas></div>`;
