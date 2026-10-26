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
  // The agreed time, or the earliest proposed one; empty for a "now" challenge (Decision 0011).
  scheduledAt: string | null;
  expiresAt: string;
  debateSlug: string | null;
  // The booked debate's status, on the challenge list.
  debateStatus?: string | null;
  topicSlug: string;
  mode?: "now" | "scheduled";
  // While in the future, an online target is answering a "now" challenge.
  respondBy?: string | null;
  proposals?: MatchingProposal[];
  initiatorHandle?: string | null;
  initiatorName?: string | null;
  targetHandle?: string | null;
  targetName?: string | null;
}
export interface MatchingProposal {
  id: string;
  proposedBy: string;
  startsAt: string;
}
export interface MatchingPerson {
  handle: string;
  displayName: string;
}

declare global {
  interface WindowEventMap {
    // The player answered or withdrew this challenge on the Match page (its request id), so the
    // site-wide challenge notice stays quiet.
    "yap:challenge-settled": CustomEvent<string>;
  }
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
