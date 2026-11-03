import type { AvatarId } from "../src/features/identity/avatars.ts";

/** JSON shapes consumed by the existing community browser modules. */
export interface CommunityMessage {
  id: string;
  debateId?: string;
  authorName?: string;
  /** The author's avatar; null for the "Participant" placeholder. */
  authorAvatarId?: AvatarId | null;
  body: string | null;
  state: "visible" | "removed";
  createdAt: string;
  clientMessageId?: string | null;
  revision: string;
  streamRevision?: string;
}
export interface ChatSubmission {
  readonly body: string;
  readonly clientMessageId: string;
  readonly createdAt: string;
}
export type SubmissionState =
  "sending" | "confirmed" | "removed" | "cooldown" | "rejected" | "unconfirmed";
export interface SubmissionRecord {
  submission: Readonly<ChatSubmission>;
  state: SubmissionState;
  attempt: number;
  serverId: string | null;
  error: string;
  settled: boolean;
  announced?: boolean;
}
export interface DeliveryError extends Error {
  status?: number;
  retryAfterSeconds?: number;
}
export interface CommunitySummary {
  likes: string;
  chatState: "open" | "paused";
  chatWritable: boolean;
  revision?: string;
}
export interface ChatPage {
  items: CommunityMessage[];
  hasMore: boolean;
}
export interface ChatSyncPage {
  watched: CommunityMessage[];
  removed?: CommunityMessage[];
}
export interface AvailableCommunityFrame {
  version: number;
  roomId: string;
  cursor: string;
  kind: "snapshot" | "changes";
  snapshot?: {
    summary: CommunitySummary;
    items: CommunityMessage[];
    hasMore: boolean;
  };
  changes?: {
    type: string;
    summary: CommunitySummary;
    message?: CommunityMessage | null;
  }[];
  more: boolean;
}
export type CommunityFrame =
  | AvailableCommunityFrame
  | {
      version: number;
      roomId: string;
      kind: "unavailable";
      cursor?: never;
      snapshot?: never;
      changes?: never;
      more?: never;
    };
export interface CommunityCase {
  id: string;
  targetType: "event" | "chat";
  status: string;
  reasonCode: string;
  action: string | null;
  createdAt: string;
  detail: string | null;
  appealStatus?: string | null;
  canAppeal?: boolean;
  chatBody?: string | null;
  decisionNote?: string | null;
  chatState?: string;
}
export interface CommunityAppeal {
  id: string;
  caseId: string;
  createdAt: string;
  reason: string;
}
export interface CaseDetail {
  history: { occurredAt: string; action: string; note?: string | null }[];
}
