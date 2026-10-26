export interface MatchingTopic {
  slug: string;
  title: string;
  publicationState: string;
  sideALabel: string;
  sideBLabel: string;
}
export interface MatchingRequest {
  id: string;
  initiatorUserId: string;
  targetUserId: string | null;
  requestedSide: "A" | "B";
  sideALabel: string;
  sideBLabel: string;
  kind: string;
  proposition: string;
  status: string;
  // Empty for a "now" challenge (Decision 0011).
  scheduledAt: string | null;
  debateSlug: string | null;
  topicSlug: string;
}
export interface MatchingEvent {
  proposition: string;
  status: string;
  scheduledAt: string;
  slug: string;
}
export interface MatchingNotification {
  id: string;
  message: string;
  createdAt: string;
  readAt: string | null;
}
