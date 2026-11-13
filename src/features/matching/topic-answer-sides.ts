import type { PoolClient } from "pg";

export class TopicAnswerSidesError extends Error {}

const slugPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

type Client = Pick<PoolClient, "query">;

export interface TopicAnswerReview {
  sideAIsYes: boolean;
  reason: string;
  reviewedAt: string;
}

export interface TopicAnswerSides {
  slug: string;
  title: string;
  sideALabel: string;
  sideBLabel: string;
  // Published debates of the topic, and those whose question is the topic title.
  debates: number;
  titleDebates: number;
  // Answers given in those debates' turn windows.
  answers: number;
  flags: string[];
  review: TopicAnswerReview | null;
}

// Decision 0015 (D4): side A answers yes to the topic's question. These are the
// labels that most likely say the opposite; a person reviews every flag.
export function likelySideMismatch(sideALabel: string, sideBLabel: string) {
  const flags: string[] = [];
  if (/^\s*yes\b/i.test(sideBLabel)) flags.push("side B starts with Yes");
  if (/^\s*(?:no|against)\b/i.test(sideALabel))
    flags.push("side A starts with No or Against");
  return flags;
}

async function requireOwner(client: Client) {
  const role = (
    await client.query<{ role: string }>("SELECT current_user AS role")
  ).rows[0]?.role;
  if (role !== "yaparena_owner")
    throw new TopicAnswerSidesError("the dedicated owner login is required");
}

// Every published topic with both labels, its debate and answer counts, its
// likely-mismatch flags and the founder's latest review. Reads only.
export async function listTopicAnswerSides(
  client: Client,
): Promise<TopicAnswerSides[]> {
  await requireOwner(client);
  const rows = (
    await client.query<{
      slug: string;
      title: string;
      sideALabel: string;
      sideBLabel: string;
      debates: number;
      titleDebates: number;
      answers: number;
      sideAIsYes: boolean | null;
      reason: string | null;
      reviewedAt: Date | null;
    }>(
      `SELECT t.slug, t.title, t.side_a_label AS "sideALabel", t.side_b_label AS "sideBLabel",
         (SELECT count(*)::int FROM debates d
           WHERE d.topic_id = t.id AND d.publication_state = 'published') AS debates,
         (SELECT count(*)::int FROM debates d
           WHERE d.topic_id = t.id AND d.publication_state = 'published'
             AND d.proposition = t.title) AS "titleDebates",
         (SELECT count(*)::int FROM coin_debate_orders o
           JOIN coin_debate_rounds r ON r.id = o.round_id AND r.turn_number IS NOT NULL
           JOIN debates d ON d.id = r.debate_id
           WHERE d.topic_id = t.id AND d.publication_state = 'published') AS answers,
         review.side_a_is_yes AS "sideAIsYes", review.reason, review.reviewed_at AS "reviewedAt"
       FROM topics t
       LEFT JOIN LATERAL (
         SELECT side_a_is_yes, reason, reviewed_at FROM topic_answer_reviews
         WHERE topic_id = t.id ORDER BY id DESC LIMIT 1
       ) review ON true
       WHERE t.publication_state = 'published'
       ORDER BY answers DESC, t.slug`,
    )
  ).rows;
  return rows.map(({ sideAIsYes, reason, reviewedAt, ...topic }) => ({
    ...topic,
    flags: likelySideMismatch(topic.sideALabel, topic.sideBLabel),
    review:
      sideAIsYes === null || reason === null || reviewedAt === null
        ? null
        : { sideAIsYes, reason, reviewedAt: reviewedAt.toISOString() },
  }));
}

// Records the founder's review of one topic in topic_answer_reviews, inside the
// caller's transaction. The latest review of a topic wins; repeating the
// current answer records nothing.
export async function recordTopicAnswerReview(
  client: Client,
  input: { slug: string; sideAIsYes: boolean; reason: string },
) {
  if (!slugPattern.test(input.slug))
    throw new TopicAnswerSidesError("invalid topic slug");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500)
    throw new TopicAnswerSidesError("the reason must be 5-500 characters");
  await requireOwner(client);
  const topic = (
    await client.query<{ id: string; previous: boolean | null }>(
      `SELECT t.id, (SELECT side_a_is_yes FROM topic_answer_reviews
           WHERE topic_id = t.id ORDER BY id DESC LIMIT 1) AS previous
       FROM topics t WHERE t.slug = $1 FOR UPDATE`,
      [input.slug],
    )
  ).rows[0];
  if (!topic) throw new TopicAnswerSidesError("topic not found");
  const result = {
    slug: input.slug,
    sideAIsYes: input.sideAIsYes,
    previous: topic.previous,
  };
  if (topic.previous === input.sideAIsYes)
    return { recorded: false, ...result };
  await client.query(
    `INSERT INTO topic_answer_reviews (topic_id, side_a_is_yes, reason)
     VALUES ($1, $2, $3)`,
    [topic.id, input.sideAIsYes, reason],
  );
  return { recorded: true, ...result };
}
