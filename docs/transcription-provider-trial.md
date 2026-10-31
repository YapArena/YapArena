# Transcription provider trial (staging procedure, run 2026-10-27)

[Decision 0012](decisions/0012-live-argument-outline.md) offers two speech-to-text providers for the
transcriber agent: Deepgram Nova-3 through LiveKit Inference, and ElevenLabs Scribe v2 Realtime.
This trial compares them on the same audio in French and English before the founder picks the
primary. Run it on staging only, never against production, with test accounts that agreed to
transcription. To run it, follow
[step 7 of the staging rollout](staging-rollout.md#7-run-the-provider-trial), which gives every
command, click and check. This page defines what the trial measures, the reference format and the
results table. It ran on staging on 2026-10-27; the [results](#results) and the
[provider decision](#provider-decision) are below.

## What it measures

| Measure                   | How                                                                                           | Target (decision record) |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------ |
| Word error rate           | Each provider's final text against a hand-corrected reference of the same turns, per language | Lower wins               |
| Final latency             | `transcript_segments.latency_ms`, speech end to final text, p50 and p95 per provider          | Captions ≤ 1 s           |
| Cost per minute           | Audio minutes sent (`audio_ms`) times the provider's hourly price                             | Report                   |
| Caption delay             | Speech end to the caption on screen, on a viewer page                                         | ≤ 1 s                    |
| Outline delay (with PR 3) | Sentence end to the outline change on screen                                                  | ≤ 3 s typical, ≤ 5 s     |
| Load                      | 50 simulated viewers (the LiveKit CLI's maximum) receiving outline messages over LiveKit      | Web CPU flat             |

The shadow provider runs on the same audio as the primary, so one session gives both providers'
text for the same speech. Each provider's latency is measured on its own stream; only the primary
drives the captions and the outline.

## Reference transcripts

For each scored turn, write what the speaker actually said, from the replay, not from either
provider's text. Keep it in a private file outside the repository:

```json
{
  "turns": [
    {
      "turnNumber": 1,
      "language": "fr",
      "text": "Le nucléaire est pilotable : il produit à la demande."
    },
    {
      "turnNumber": 2,
      "language": "en",
      "text": "Renewables are cheaper and faster to build."
    }
  ]
}
```

Scoring lowercases, removes punctuation and splits French elisions (`l'énergie` is `l'` and
`énergie`), the same way for the reference and both providers, so only words count.

## Results

Staging, 2026-10-27, test accounts A (French) and B (English) reading the same five-turn scripts in
both sessions. Session 1 was debate `5279c7da-0661-46dc-999d-c18b27ab74b1` with Deepgram primary;
session 2 was debate `ec273083-9182-43ec-837a-f31a7e6406a3` with ElevenLabs primary. The agent ran
`dee8a4c` (#132); web and jobs ran `f80926e`. An earlier session 1 (`98e82b7b`) is excluded:
Deepgram received no language and transcribed French as English, which #132 fixed.

| Date       | Session | Provider   | Role    | Language | Turns | WER   | Latency p50 / p95 | Cost per minute | Caption delay | Outline delay (estimate)              |
| ---------- | ------- | ---------- | ------- | -------- | ----- | ----- | ----------------- | --------------- | ------------- | ------------------------------------- |
| 2026-10-27 | 1       | Deepgram   | primary | en       | 5     | 7.6%  | 0.47 s / 1.94 s   | $0.0048         | not measured  | 2.5 s median, 5.1 s p90, 10.5 s max   |
| 2026-10-27 | 1       | Deepgram   | primary | fr       | 5     | 10.4% | 0.55 s / 2.15 s   | $0.0048         | not measured  | 2.8 s median, 5.1 s p90, 7.0 s max    |
| 2026-10-27 | 1       | ElevenLabs | shadow  | en       | 5     | 4.9%  | 0.68 s / 1.97 s   | $0.0065         |               |                                       |
| 2026-10-27 | 1       | ElevenLabs | shadow  | fr       | 5     | 7.3%  | 1.64 s / 2.06 s   | $0.0065         |               |                                       |
| 2026-10-27 | 2       | Deepgram   | shadow  | en       | 5     | 7.9%  | 0.20 s / 2.03 s   | $0.0048         |               |                                       |
| 2026-10-27 | 2       | Deepgram   | shadow  | fr       | 5     | 5.6%  | 0.71 s / 2.15 s   | $0.0048         |               |                                       |
| 2026-10-27 | 2       | ElevenLabs | primary | en       | 5     | 4.3%  | 0.59 s / 7.36 s   | $0.0065         | not measured  | 14.4 s median, 28.5 s p90, 35.2 s max |
| 2026-10-27 | 2       | ElevenLabs | primary | fr       | 5     | 3.5%  | 1.37 s / 1.98 s   | $0.0065         | not measured  | 13.5 s median, 31.2 s p90, 35.9 s max |

Load check: not run.

- **References** are the scripts as written, with stage directions removed, rather than
  transcriptions of the replays: the speakers read them closely. A departure from the script counts
  against both providers alike, so the comparison within a session stays fair, but the absolute
  error rates are slightly high.
- **Prices:** Deepgram Nova-3 on LiveKit Inference, $0.288 an hour; ElevenLabs Scribe v2 Realtime,
  $0.39 an hour on every plan (read 2026-10-27).
- **Caption delay** was not measured: both screen recordings failed. The latency column is when
  the final text reached the agent, not what viewers saw; captions show in-progress text before
  it.
- **Outline delay** is estimated from stored timestamps, not recordings: from each sentence's end
  (the primary provider's word timings in `transcript_segments.words`) to `created_at` of the
  first `outline_versions` row whose span covers that segment. It leaves out LiveKit delivery to
  the page, usually a fraction of a second, and the agent's and the database's clocks may differ
  slightly. Every version (69 in session 1, 20 in session 2) matched the segments it covered. The
  Claude Haiku 5.5 call took 1.2 s at the median and 2.1 s at p95 in session 1 (132 calls), and
  1.8 s and 2.8 s in session 2 (23 calls).
- **ElevenLabs as primary** finalized only 2 to 4 segments per turn, against 10 to 16 for Deepgram.
  The agent connected with ElevenLabs' pause-based commit at its default pause, which read speech
  rarely reached, so Scribe committed after about 36 seconds of audio. The live outline reads
  finals only, hence its delay. The text was complete: on every turn ElevenLabs had 907 to 991
  characters against Deepgram's 887 to 959, and no segment reached the 1,000-character limit.
  #133 makes it commit after 0.5 seconds of silence.
- **Window cleanups:** in both sessions the last turn kept its frozen outline because the agent
  never cleaned the last turn (fixed in #133). In session 1, the agent rejected turn 1's cleanup as
  invalid, probably over the 4-argument or 6-point limit; #133 logs the reason.

## Provider decision

ElevenLabs had the lower word error rate in all four same-audio comparisons: 4.6% against 7.8% in
English and 5.4% against 8.0% in French over both sessions. Deepgram's final text is faster and
it meets the outline target typically; ElevenLabs, as connected during the trial, does not. On
2026-10-27 the founder chose Deepgram as the only provider for now, to test matchmaking, and
ElevenLabs as the long-term provider once a retest with #133 shows its outline delay within the
target. The ElevenLabs key stays in the agent's secrets for that retest.
