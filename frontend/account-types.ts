export interface Profile {
  handle: string;
  displayName: string;
  bio: string | null;
  publicationState: "draft" | "published" | "hidden";
}
export interface AccountUser {
  id: string;
  email: string | null;
}
export interface FollowEntry {
  targetType: string;
  title: string;
  slug: string;
}
export interface ActivityEntry {
  eventType: string;
  label: string;
  occurredAt: string;
}
export interface CollectionPage<T> {
  items: T[];
  pagination: { hasMore: boolean };
}
export interface AccountError extends Error {
  status?: number;
  field?: string;
}

declare global {
  interface WindowEventMap {
    /** The signed-in account created or changed its profile. */
    "yap:profile-changed": CustomEvent<Profile>;
  }
}
