// Decision 0015: what the topic page reads. The stored figure, history and
// per-debate results (repository.ts), and whether side A answers yes (D4):
// the founder's latest review in topic_answer_reviews, and yes when the topic
// was never reviewed.
import { createEndorsementRepository, type Queryable } from "./repository.ts";
import type { TopicEndorsementPage } from "./types.ts";

export interface TopicEndorsementView extends TopicEndorsementPage {
  /** False when the founder reviewed the topic as "side A is not yes". */
  sideAIsYes: boolean;
}

export async function topicSideAIsYes(
  database: Queryable,
  topicId: string,
): Promise<boolean> {
  const row = (
    await database.query<{ sideAIsYes: boolean }>(
      `SELECT side_a_is_yes AS "sideAIsYes" FROM topic_answer_reviews
      WHERE topic_id=$1 ORDER BY id DESC LIMIT 1`,
      [topicId],
    )
  ).rows[0];
  return row?.sideAIsYes ?? true;
}

export function createTopicEndorsementReader(
  database: Queryable,
  rail: string,
) {
  const repository = createEndorsementRepository(database, rail);
  return Object.freeze({
    async topic(topicId: string): Promise<TopicEndorsementView> {
      const [page, sideAIsYes] = await Promise.all([
        repository.topic(topicId),
        topicSideAIsYes(database, topicId),
      ]);
      return { ...page, sideAIsYes };
    },
  });
}
