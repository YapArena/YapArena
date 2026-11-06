// Topic categories: the founder's list (2026-11-06; Decision 0003), in display
// order. Browser-safe: the server validates with it and pages list it. The ids
// are what the database stores and the API sends; the database checks the same
// list (migrations/1794001552074_add-topic-categories.js), so a new category
// needs a migration too.

export const TOPIC_CATEGORIES = [
  ["politics", "Politics"],
  ["society", "Society"],
  ["cities", "Cities"],
  ["technology", "Technology"],
  ["work", "Work"],
  ["climate", "Climate"],
  ["education", "Education"],
  ["economy", "Economy"],
  ["other", "Other"],
] as const;

export type TopicCategory = (typeof TOPIC_CATEGORIES)[number][0];

export const TOPIC_CATEGORY_IDS: readonly TopicCategory[] =
  TOPIC_CATEGORIES.map(([id]) => id);

/** A topic created without a category, and every topic that predates them. */
export const DEFAULT_TOPIC_CATEGORY: TopicCategory = "other";

const names = new Map<string, string>(TOPIC_CATEGORIES);

export function isTopicCategory(value: unknown): value is TopicCategory {
  return typeof value === "string" && names.has(value);
}

export const topicCategoryName = (id: TopicCategory) => names.get(id)!;
