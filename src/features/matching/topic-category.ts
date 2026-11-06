import type { PoolClient } from "pg";
import {
  isTopicCategory,
  TOPIC_CATEGORY_IDS,
  type TopicCategory,
} from "../discovery/topic-categories.ts";

export class TopicCategoryError extends Error {}

const slugPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

// Owner-only (Decision 0003): changes one topic's category inside the
// caller's transaction and records the previous category and the owner's
// reason in topic_category_changes. The database refuses a category change by
// any other role. Choosing the current category changes nothing.
export async function changeTopicCategory(
  client: Pick<PoolClient, "query">,
  input: { slug: string; category: string; reason: string },
) {
  if (!slugPattern.test(input.slug))
    throw new TopicCategoryError("invalid topic slug");
  if (!isTopicCategory(input.category))
    throw new TopicCategoryError(
      `choose a category: ${TOPIC_CATEGORY_IDS.join(", ")}`,
    );
  const category = input.category;
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500)
    throw new TopicCategoryError("the reason must be 5-500 characters");
  const role = (
    await client.query<{ role: string }>("SELECT current_user AS role")
  ).rows[0]?.role;
  if (role !== "yaparena_owner")
    throw new TopicCategoryError("the dedicated owner login is required");
  const topic = (
    await client.query<{ id: string; category: TopicCategory }>(
      "SELECT id, category FROM topics WHERE slug=$1 FOR UPDATE",
      [input.slug],
    )
  ).rows[0];
  if (!topic) throw new TopicCategoryError("topic not found");
  const result = {
    slug: input.slug,
    category,
    previousCategory: topic.category,
  };
  if (topic.category === category) return { changed: false, ...result };
  await client.query(
    "UPDATE topics SET category=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$1",
    [topic.id, category],
  );
  await client.query(
    `INSERT INTO topic_category_changes (topic_id, from_category, to_category, reason)
     VALUES ($1, $2, $3, $4)`,
    [topic.id, topic.category, category, reason],
  );
  return { changed: true, ...result };
}
