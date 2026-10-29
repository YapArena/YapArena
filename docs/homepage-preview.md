# Live discovery and debate previews

The former homepage content now lives at `/live`, reached through the shared
Live navigation link. The subsequent [wide homepage](wide-homepage.md) replaces
the temporary centered logo at `/` (now at `/home`, after the
[landing page](landing-page.md)); its Watch debates link reaches Live.
The Live page retains the full-width navy video hero, Topics in play and preview
note. Under Debates to watch, video cards replace the former text panels while
keeping the three-column grid, 14px gutters and 320px minimum card height
(two columns on tablet, one on mobile). Footage fills the card with `object-fit: cover`; its question, topic, state and public speakers sit over a navy gradient.

The hero uses the first playable debate in the ranked feed. Its question, topic,
speakers and opposing positions are rendered with the HTML. A configured live broadcast takes priority; otherwise a playable
replay is explicitly labeled. Fictional demos, hidden debates/topics and unready
recordings are excluded. With no eligible media, a branded static hero retains
discovery links and makes no media request. There is no Watch now button.

## Selection and coin volume

The server considers the 50 most recent eligible debates, with live first. Within
each live/replay group it ranks by executed human Yap Coins premium volume from
the latest 100 settled, revealed rounds, then by recency and ID. This matches the
existing settlement chart's bounded history window and uses exact numeric sums.
Fees, reservations, failed/unexecuted commitments, pending rounds, future reveal
times, private mixed Bots sandboxes and observer runs contribute nothing. Likes
do not affect selection. A newer debate wins a zero-volume or equal-volume tie.
This is play-coin volume, not cash or a new real-fund feature. No totals or private
receipt details are embedded in the page.

Selection uses existing indexed debate/session/round/submission relationships.
The SQL has bounded candidate/settled windows and no provider request on the HTML
path. Normal publication and media eligibility are checked again by the existing
viewer-token/replay endpoints. A single ranked query returns up to nine debates
for the hero and cards on each Live visit. Upcoming listings remain accessible through Explore; the video feed
excludes unready media instead of pretending those listings are playing.
No schema migration, public database grant or new dependency is required.

## Recording thumbnails

Each recording's own JPEG thumbnail sits behind its video and remains
visible while playback loads, buffers, pauses or is disabled. The YES/NO text
backdrop is removed from featured debates. Card images are lazy-loaded; each
preview requests its small image from
`GET /api/media/events/:id/thumbnail`, without initializing a video decoder or SDK.
That endpoint rechecks the public debate/topic and verified replay, serves at most
300 KB from private storage and never exposes a recording key or signed media URL.

The existing replay worker generates thumbnails after its encoding batch drains.
It scans eligible ready packages, downloads only their first 720p segment (at most
4 MB), and extracts a representative 960×540 JPEG. FFmpeg runs only in the encoder,
with one thread, a ten-second process limit and a 25-second task deadline. Each
image uses an immutable key derived from its source recording. Existing packages
are backfilled without re-encoding recordings; stored images survive restarts.
Completion hints are bounded and failures retry after five minutes. No database
migration, new worker or hosting-plan change is needed.

If a thumbnail is still being generated, the browser makes at most three delayed
retries while visible. Without a usable image, the question stays on plain navy;
it never substitutes artwork from another debate. A live event without a completed
recording has no derived recording thumbnail yet.

## Playback and entry

The shared preview controller waits for page load and idle time before obtaining
media. It renders into reserved hero/card space. LiveKit is imported only for
an actual live preview; the HLS library loads only for a replay needing it. Native replay
does not fetch either SDK. Live preview uses viewer-only grants, subscribes to
camera video at LOW quality and does not subscribe to audio or capture devices.
HLS preview stays on the lowest rendition with a 2–4 second / 2 MB configured
buffer. Native video buffering remains browser-managed.

Playback is muted and inline. Offscreen, hidden-tab, offline and page-exit events
release the player/connection and cancel pending access. Automatic playback is
skipped for reduced motion, Save-Data and 2G/slow-2G connections; explicit Play
preview can opt in. A pause/play control is always available. One shared scheduler
allows **at most one active transport across the hero and every card**, including
while loading.
The current preview remains selected while sufficiently visible (25% hero, 50%
card); hovering or focusing another visible card transfers playback after releasing
the previous player. Scrolling selects the next eligible card. Nonselected cards
keep their own thumbnails and do not request playback grants or video bytes.

The hero retains its 30-second teaser limit. A selected replay card loops whenever
it reaches the end and continues until paused, deselected or outside the viewport.
A preview without frames stops after 12 seconds.
Denied access, blocked autoplay and media
failure preserve the readable question and functioning debate link.

Hover emphasizes the video. Cards open only on click/tap/Enter, with their own
preview toggle; there is no automatic hover navigation in the grid. Continuous
mouse hover on the hero link for 2.6 seconds
shows a themed progress indicator and opens the ordinary watching interface.
Leaving, scrolling, Escape, pause or backgrounding cancels it. Buffering resets
the countdown; when playback resumes with the mouse still over the hero, a fresh
continuous countdown begins.
There is no hover navigation under reduced motion or on touch; click/tap and
keyboard Enter open immediately. Preview controls never trigger entry. Full
watching controls retain their existing behavior.

These previews do not send playback-presence heartbeats or watch sessions and do
not change measurement consent. They consume actual media bandwidth and decoding
time after the page loads; lazy loading is not a claim of zero resource cost or
proof of production-scale performance.

## Verification

`npm run check` covers selection/publication rendering, hover intent, autoplay
policy, live subscription/cleanup and HLS preview limits. The disposable database
quality gate supplies the existing explicit A4 database URLs to the featured
ranking test, which refuses hosted databases. It verifies volume beats likes,
recency ties, live priority and hidden/private/pending exclusions.
The CI integration smoke check verifies the landing page at `/`, the wide homepage at `/home` and seeded discovery
content at `/live`, alongside the existing public API checks.

```sh
A4_QUALITY=true DATABASE_TEST_MODE=host node scripts/verify-database-isolation.ts
node scripts/verify-hero-browser.ts
REPLAY_POSTGRES_MODE=host node scripts/verify-replay-pipeline.ts
```

The browser trial serves six synthetic WebM cards on loopback. It checks the
homepage and Live navigation, original grid geometry, one active preview, hover
and keyboard handoff, actual replay end-to-start looping, hidden-tab release, and
actual muted playback, no unnecessary SDK requests, pause/offscreen cleanup, hover cancellation
and entry, click/touch layout, reduced motion, data saving, denial fallback and axe.
It does not establish LiveKit/R2 delivery quality, physical-device behavior or
production load. The user performs staging acceptance; no hosted account or smoke
round is created for this release.

See the [Live-page update and staging handoff](evidence/homepage-preview/live-feed-2026-10-16.md)
and [original hero evidence](evidence/homepage-preview/2026-10-16.md).
