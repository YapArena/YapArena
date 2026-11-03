// Type-only contracts for immutable applied JavaScript migration exports.
declare module "*1791158400000_isolate_server_database.js" {
  import type { MigrationBuilder } from "node-pg-migrate";

  export const shorthands: undefined;
  export const runtimeGrants: Readonly<{
    users: string;
    sessions: string;
    messages: string;
    public_profiles: string;
    topics: string;
    sponsors: string;
    debates: string;
    follows: string;
    account_roles: string;
    identity_audit_events: string;
    wallet_identities: string;
    wallet_challenges: string;
    event_rule_versions: string;
    match_requests: string;
    event_participants: string;
    event_history: string;
    account_notifications: string;
    debate_media: string;
    media_device_checks: string;
    event_chat_controls: string;
    event_chat_messages: string;
    event_likes: string;
    moderation_cases: string;
    community_restrictions: string;
    moderation_appeals: string;
    community_audit_events: string;
    event_like_changes: string;
    product_measurement_consents: string;
    product_measurement_affiliations: string;
    product_measurement_affiliation_audit: string;
    product_measurement_events: string;
    product_measurement_watch_sessions: string;
  }>;
  export const applicationRoutines: string[];
  export const up: (pgm: MigrationBuilder) => void;
  export const down: (pgm: MigrationBuilder) => void;
}

declare module "*1791335211412_durable-community-delivery.js" {
  import type { MigrationBuilder } from "node-pg-migrate";

  export const shorthands: undefined;
  export const deliveryTables: string[];
  export const up: (pgm: MigrationBuilder) => void;
  export const down: (pgm: MigrationBuilder) => void;
}

declare module "*1791345540042_preserve-chat-idempotency.js" {
  import type { MigrationBuilder } from "node-pg-migrate";

  export const shorthands: undefined;
  export const receiptTables: string[];
  export const up: (pgm: MigrationBuilder) => void;
  export const down: (pgm: MigrationBuilder) => void;
}

declare module "*1792093616251_add-a4-yap-coins.js" {
  import type { MigrationBuilder } from "node-pg-migrate";

  export const a4Tables: string[];
  export const up: (pgm: MigrationBuilder) => void;
  export const down: (pgm: MigrationBuilder) => void;
}

declare module "*1792195231830_add-public-bot-discovery.js" {
  import type { MigrationBuilder } from "node-pg-migrate";

  export const shorthands: undefined;
  export const publicBotTables: string[];
  export const up: (pgm: MigrationBuilder) => void;
  export const down: (pgm: MigrationBuilder) => void;
}

declare module "*1791385198189_automatic-replay-packaging.js" {
  import type { MigrationBuilder } from "node-pg-migrate";

  export const shorthands: undefined;
  export const replayJobTables: string[];
  export const up: (pgm: MigrationBuilder) => void;
  export const down: (pgm: MigrationBuilder) => void;
}

declare module "*1793675904690_add-replay-encoder-role.js" {
  import type { MigrationBuilder } from "node-pg-migrate";

  type Columns = "*" | readonly string[];
  export type EncoderGrant = {
    readonly select?: Columns;
    readonly insert?: Columns;
    readonly update?: readonly string[];
    readonly delete?: boolean;
  };
  export const shorthands: undefined;
  export const encoderRole: "yaparena_encoder";
  export const encoderGrants: Readonly<Record<string, EncoderGrant>>;
  export const encoderSequences: readonly string[];
  export function encoderGrantClauses(spec: EncoderGrant): string;
  export const up: (pgm: MigrationBuilder) => void;
  export const down: (pgm: MigrationBuilder) => void;
}
