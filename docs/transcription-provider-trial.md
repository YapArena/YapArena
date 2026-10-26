# Transcription provider trial (staging procedure, not yet run)

[Decision 0012](decisions/0012-live-argument-outline.md) offers two speech-to-text providers for the
transcriber agent: Deepgram Nova-3 through LiveKit Inference, and ElevenLabs Scribe v2 Realtime.
This trial compares them on the same audio in French and English before the founder picks the
primary. Run it on staging only, never against production, with test accounts that agreed to
transcription. It has not been run yet. To run it, follow
[step 7 of the staging rollout](staging-rollout.md#7-run-the-provider-trial), which gives every
command, click and check. This page defines what the trial measures, the reference format and the
results table.

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

| Date | Session | Provider | Role | Language | Turns | WER | Latency p50 / p95 | Cost per minute | Caption delay | Outline delay |
| ---- | ------- | -------- | ---- | -------- | ----- | --- | ----------------- | --------------- | ------------- | ------------- |
|      |         |          |      |          |       |     |                   |                 |               |               |

Load check: not run.
