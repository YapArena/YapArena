import type { PublicDebate, PublicTopic } from "./public-types.ts";
import type { AvatarId } from "../identity/avatars.ts";
import type { PublicBotActivity } from "../a4/public-bot-types.ts";

export interface HomeDebate {
  id: string;
  kind: "live" | "replay" | "upcoming";
  title: string;
  names: string[];
  /** Each speaker's avatar address; null shows their initials (Decision 0014). */
  avatars?: [string | null, string | null];
  meta: string;
  stamp: string;
  href: string | null;
  /** When an upcoming debate starts (ISO), if it is scheduled. */
  startsAt?: string | null;
}
export interface HomeIdea {
  id: string;
  cat: string;
  title: string;
  short: string;
  href: string | null;
  topicSlug: string | null;
  reference: boolean;
  demo: boolean;
  pct: number | null;
  delta: number | null;
  vol: number | null;
  people: number | null;
  price: number | null;
  points: number[];
  live: number;
  viewers: string | null;
  yes: string;
  no: string;
  arguments: { stance: string; text: string; rate: number | null }[];
  debates: HomeDebate[];
  activity?: PublicBotActivity;
}
export interface HomeData {
  reference: boolean;
  available: boolean;
  ideas: HomeIdea[];
  following: string[];
}
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("");

// Topic-level market/argument histories do not exist. A4 debate settlements are
// distinct from an ongoing idea market and are not silently relabeled as one.
export function publicHomepage(
  topics: PublicTopic[],
  playable: PublicDebate[],
  activity: Record<string, PublicBotActivity> = {},
  // The server passes the versioned avatar address; without it, initials show.
  avatarUrl?: (id: AvatarId) => string,
): HomeData {
  return {
    reference: false,
    available: true,
    following: [],
    ideas: topics.map((topic) => {
      const history = activity[topic.id];
      const synthetic = history && history.items.length ? history : undefined;
      const last = synthetic?.items.at(-1);
      const percent = (share: { n: string; d: string } | null | undefined) =>
        share ? (Number(share.n) * 100) / Number(share.d) : null;
      const latest = percent(last?.share);
      const first = percent(
        synthetic?.items.find(
          (r) => Date.parse(r.settledAt) > Date.now() - 86400000,
        )?.share,
      );
      const debates: HomeDebate[] = playable
        .filter((debate) => debate.topic.slug === topic.slug)
        .map((debate) => {
          const a = debate.speakerA?.displayName ?? "Speaker A";
          const b = debate.speakerB?.displayName ?? "Speaker B";
          return {
            id: debate.id,
            kind:
              debate.status === "live"
                ? "live"
                : ["replay", "finalized"].includes(debate.status)
                  ? "replay"
                  : "upcoming",
            title: debate.proposition,
            names: [a, b, initials(a), initials(b)],
            avatars: [
              debate.speakerA && avatarUrl
                ? avatarUrl(debate.speakerA.avatarId)
                : null,
              debate.speakerB && avatarUrl
                ? avatarUrl(debate.speakerB.avatarId)
                : null,
            ],
            meta:
              debate.status === "live"
                ? "Live debate"
                : ["replay", "finalized"].includes(debate.status)
                  ? "Replay debate"
                  : "Upcoming / awaiting media",
            stamp:
              debate.status === "live"
                ? "Live"
                : ["replay", "finalized"].includes(debate.status)
                  ? "Replay"
                  : "Upcoming",
            href: `/debates/${encodeURIComponent(debate.slug)}`,
            startsAt: debate.scheduledAt
              ? new Date(debate.scheduledAt).toISOString()
              : null,
          };
        });
      return {
        id: topic.id,
        topicSlug: topic.slug,
        href: `/topics/${encodeURIComponent(topic.slug)}`,
        cat: synthetic?.category ?? "Ideas",
        title: debates[0]?.title ?? topic.title,
        short: debates[0]?.title ?? topic.title,
        reference: false,
        demo: topic.isDemo,
        pct: latest,
        delta:
          latest !== null && first !== null
            ? Math.round((latest - first) * 10) / 10
            : null,
        vol: synthetic
          ? synthetic.items
              .filter((r) => Date.parse(r.settledAt) > Date.now() - 86400000)
              .reduce((n, r) => n + Number(r.premium), 0) / 1e9
          : null,
        people: last ? last.humans + last.bots : null,
        price: last?.offer ? Number(last.offer.n) / Number(last.offer.d) : null,
        points: synthetic
          ? synthetic.items.filter((r) => r.share).map((r) => percent(r.share)!)
          : [],
        viewers: null,
        live: debates.filter((debate) => debate.kind === "live").length,
        yes: topic.sideALabel,
        no: topic.sideBLabel,
        arguments: synthetic?.arguments ?? [
          { stance: "for", text: topic.sideALabel, rate: null },
          { stance: "against", text: topic.sideBLabel, rate: null },
        ],
        debates,
        ...(synthetic ? { activity: synthetic } : {}),
      };
    }),
  };
}
export const emptyIdea: HomeIdea = {
  id: "empty",
  cat: "Ideas",
  title: "The next idea is taking shape.",
  short: "Explore the arena",
  reference: false,
  demo: false,
  href: "/topics",
  topicSlug: null,
  pct: null,
  delta: null,
  vol: null,
  people: null,
  price: null,
  points: [],
  live: 0,
  viewers: null,
  yes: "Hear both sides.",
  no: "Discover a new perspective.",
  arguments: [],
  debates: [],
};
