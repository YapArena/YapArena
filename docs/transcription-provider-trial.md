# Transcription provider trial (staging procedure, not yet run)

[Decision 0012](decisions/0012-live-argument-outline.md) offers two speech-to-text providers for the
transcriber agent: Deepgram Nova-3 through LiveKit Inference, and ElevenLabs Scribe v2 Realtime.
This procedure compares them on the same audio in French and English before the founder picks the
primary. Run it on staging only, never against production, with test accounts that agreed to
transcription. It has not been run yet; record the results in the table at the end.

## What it measures

| Measure                   | How                                                                                           | Target (decision record) |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------ |
| Word error rate           | Each provider's final text against a hand-corrected reference of the same turns, per language | Lower wins               |
| Final latency             | `transcript_segments.latency_ms`, speech end to final text, p50 and p95 per provider          | Captions ≤ 1 s           |
| Cost per minute           | Audio minutes sent (`audio_ms`) times the provider's hourly price                             | Report                   |
| Caption delay             | Speech end to the caption on screen, on a viewer page                                         | ≤ 1 s                    |
| Outline delay (with PR 3) | Sentence end to the outline change on screen                                                  | ≤ 3 s typical, ≤ 5 s     |
| Load                      | 500 viewers receiving outline messages over LiveKit                                           | Web CPU flat             |

The shadow provider runs on the same audio as the primary, so one session gives both providers'
text for the same speech. Each provider's latency is measured on its own stream; only the primary
drives the captions and the outline.

## Setup

1. Deploy the transcriber agent as in the staging guide's "Enable live transcription and captions",
   with `TRANSCRIPTION_PROVIDER=deepgram`, `TRANSCRIPTION_SHADOW_PROVIDER=elevenlabs` and
   `ELEVEN_API_KEY`. Turn windows and the coin sandbox are not needed.
2. Prepare two test debaters: one sets French, the other English, on the account's Profile tab.
3. Write a script for each debater: about ten one-minute turns in all, with numbers, proper names,
   technical terms and overlapping-turn edges (finishing a sentence at the deadline). Read it
   naturally, at a normal pace, on the devices and microphones users will use.

## Session 1: Deepgram primary, ElevenLabs shadow

1. Start the debate and run all the turns. Watch the debate page as a viewer on a second device
   for the caption and outline delays below.
2. After the debate ends and the recording is ready, note the debate ID.

## Session 2: ElevenLabs primary, Deepgram shadow

Set `TRANSCRIPTION_PROVIDER=elevenlabs` and `TRANSCRIPTION_SHADOW_PROVIDER=deepgram`
(`lk agent update-secrets` restarts the agent), and repeat with the same scripts. This gives each
provider's caption delay as the primary.

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

## Report

With a read-only runtime connection to the staging database:

```sh
npm run build
TRANSCRIPTION_TRIAL_DATABASE_URL=... node scripts/transcription-trial.ts <debate id> /private/path/reference.json
```

It prints one row per provider, role and language: scored turns, words, word error rate with
substitutions, deletions and insertions, latency p50/p95, audio minutes and estimated cost. The
default prices are $0.29 an hour for Nova-3 and $0.39 for Scribe v2 Realtime (read 2026-10-25);
pass `--deepgram-per-hour=` and `--elevenlabs-per-hour=` with current prices. It prints no
transcript text or connection details.

## End-to-end delays

- **Captions.** On the viewer device, record the screen with the speaker audible (for example a
  phone video of both). For ten sentence ends per provider, measure from the last word heard to the
  caption's final text.
- **Outline (needs the AI outline).** In the same recordings, measure from a sentence end to the
  outline change for ten sentences. `lk agent logs` lines `live outline call` give the model's part
  (`latencyMs`); the rest is ingest and LiveKit delivery.

## Load check

With the AI outline on, in one debate: connect 500 subscribe-only participants to the debate's
room, for example with `lk load-test --room debate-<id> --subscribers 500` from a machine outside
Render, while the debate runs for at least five turns. Watch the web service's CPU on Render's
metrics. Outline messages go through LiveKit, so web CPU should stay flat; any rise means pages
are re-reading the outline over HTTP. Check one subscriber page still applies versions without
gaps.

## Results

| Date | Session | Provider | Role | Language | Turns | WER | Latency p50 / p95 | Cost per minute | Caption delay | Outline delay |
| ---- | ------- | -------- | ---- | -------- | ----- | --- | ----------------- | --------------- | ------------- | ------------- |
|      |         |          |      |          |       |     |                   |                 |               |               |

Load check: not run.
