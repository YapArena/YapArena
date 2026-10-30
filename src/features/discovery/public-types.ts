export type DebateStatus =
  | "draft"
  | "accepted"
  | "scheduled"
  | "ready"
  | "live"
  | "ended"
  | "replay"
  | "void_review"
  | "finalized"
  | "cancelled";

export interface PublicTopic {
  id: string;
  slug: string;
  title: string;
  summary: string;
  sideALabel: string;
  sideBLabel: string;
  isDemo: boolean;
  createdAt: Date;
}

export interface PublicProfile {
  id: string;
  handle: string;
  displayName: string;
  bio: string | null;
  isDemo: boolean;
}

export interface PublicDebate {
  id: string;
  slug: string;
  proposition: string;
  status: DebateStatus;
  rulesVersion: string;
  scheduledAt: Date | null;
  liveStartedAt: Date | null;
  liveEndedAt: Date | null;
  isDemo: boolean;
  createdAt: Date;
  topic: Pick<PublicTopic, "slug" | "title" | "sideALabel" | "sideBLabel">;
  speakerA: Pick<PublicProfile, "handle" | "displayName"> | null;
  speakerB: Pick<PublicProfile, "handle" | "displayName"> | null;
  sponsor: { name: string; disclosure: string } | null;
  /**
   * The debate's turn timing from its rules version, read with a single
   * debate only (absent from lists): turns of `turnSeconds` each, `turnCount`
   * of them at most. Null when the rules don't specify usable timings.
   */
  timing?: { turnCount: number; turnSeconds: number } | null;
}

export interface PublicList<T> {
  items: T[];
  pagination: { limit: number; offset: number; hasMore: boolean };
}
