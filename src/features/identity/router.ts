import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { createIdentityRepository } from "./repository.ts";
import type { ProductActionRecorder } from "../measurement/router.ts";
import { MINIMUM_AGE, TERMS_VERSION } from "./terms.ts";
import { isAvatarId, type AvatarId } from "./avatars.ts";
import { hasHiddenCharacters, isReservedName } from "../community/user-text.ts";

type Repository = ReturnType<typeof createIdentityRepository>;
const handlePattern = /^[a-z0-9][a-z0-9-]{2,39}$/;
const topicPattern = /^[a-z0-9][a-z0-9-]{2,79}$/;

function pagination(query: Record<string, unknown>) {
  const parse = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number <= max ? number : null;
  };
  const limit = parse(query.limit, 20, 50);
  const offset = parse(query.offset, 0, 10_000);
  return limit !== null && limit >= 1 && offset !== null
    ? { limit, offset }
    : null;
}

type ProfileField =
  "handle" | "displayName" | "bio" | "publicationState" | "avatarId" | "terms";
type FieldProblem = { field?: ProfileField; message: string };

// People see these messages next to the field they describe.
const problems = {
  body: { message: "invalid profile fields" },
  handle: {
    field: "handle",
    message:
      "Use 3 to 40 lowercase letters, numbers or hyphens, starting with a letter or number.",
  },
  handleReserved: {
    field: "handle",
    message: "That handle is reserved. Try another.",
  },
  displayName: {
    field: "displayName",
    message: "Enter a username between 1 and 80 characters.",
  },
  displayNameHidden: {
    field: "displayName",
    message: "Remove hidden or control characters from your username.",
  },
  displayNameReserved: {
    field: "displayName",
    message: "Choose a username that doesn't look like YAP Arena staff.",
  },
  bio: { field: "bio", message: "Keep your bio to 500 characters or fewer." },
  bioHidden: {
    field: "bio",
    message: "Remove hidden or control characters from your bio.",
  },
  publicationState: {
    field: "publicationState",
    message: "Choose a public or private profile.",
  },
  avatarId: { field: "avatarId", message: "Choose one of the avatars." },
  terms: {
    field: "terms",
    message: `Confirm you're ${MINIMUM_AGE} or older and accept the Terms of Use and Privacy Policy.`,
  },
} as const satisfies Record<string, FieldProblem>;

function invalid(response: Response, problem: FieldProblem) {
  return response.status(400).json({
    error: problem.message,
    code: problem === problems.terms ? "terms_required" : "invalid_profile",
    ...(problem.field ? { field: problem.field } : {}),
  });
}

function profileInput(body: unknown):
  | {
      value: {
        handle: string;
        displayName: string;
        bio: string | null;
        publicationState: "draft" | "published";
        avatarId: AvatarId | null;
        acceptTerms: boolean;
      };
    }
  | { problem: FieldProblem } {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { problem: problems.body };
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "handle",
          "displayName",
          "bio",
          "publicationState",
          "avatarId",
          "acceptTerms",
        ].includes(key),
    )
  )
    return { problem: problems.body };
  const handle = value.handle;
  const displayName = value.displayName;
  const bio = value.bio ?? null;
  const publicationState = value.publicationState ?? "draft";
  // Without a choice the profile shows the handle's default avatar.
  const avatarId = value.avatarId ?? null;
  if (typeof handle !== "string" || !handlePattern.test(handle))
    return { problem: problems.handle };
  if (isReservedName(handle)) return { problem: problems.handleReserved };
  if (
    typeof displayName !== "string" ||
    displayName.trim().length < 1 ||
    displayName.trim().length > 80
  )
    return { problem: problems.displayName };
  if (bio !== null && (typeof bio !== "string" || bio.length > 500))
    return { problem: problems.bio };
  const content = textProblem({ displayName: displayName.trim(), bio });
  if (content) return { problem: content };
  if (publicationState !== "draft" && publicationState !== "published")
    return { problem: problems.publicationState };
  if (avatarId !== null && !isAvatarId(avatarId))
    return { problem: problems.avatarId };
  if (value.acceptTerms !== undefined && typeof value.acceptTerms !== "boolean")
    return { problem: problems.terms };
  return {
    value: {
      handle,
      displayName: displayName.trim(),
      bio,
      publicationState,
      avatarId,
      acceptTerms: value.acceptTerms === true,
    },
  };
}

// Names and bios are public: no hidden characters and no staff look-alike names (YA-22). A field
// saved before these rules is checked again only when it changes.
function textProblem(
  changes: { displayName?: string; bio?: string | null },
  current?: { displayName: string; bio: string | null },
): FieldProblem | null {
  const { displayName, bio } = changes;
  if (displayName !== undefined && displayName !== current?.displayName) {
    if (hasHiddenCharacters(displayName)) return problems.displayNameHidden;
    if (isReservedName(displayName)) return problems.displayNameReserved;
  }
  if (
    typeof bio === "string" &&
    bio !== current?.bio &&
    hasHiddenCharacters(bio, { multiline: true })
  )
    return problems.bioHidden;
  return null;
}

function profileChanges(body: unknown):
  | {
      value: {
        displayName?: string;
        bio?: string | null;
        publicationState?: "draft" | "published";
        avatarId?: AvatarId;
      };
    }
  | { problem: FieldProblem } {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { problem: problems.body };
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (
    !keys.length ||
    keys.some(
      (key) =>
        !["displayName", "bio", "publicationState", "avatarId"].includes(key),
    )
  )
    return { problem: problems.body };
  const changes: {
    displayName?: string;
    bio?: string | null;
    publicationState?: "draft" | "published";
    avatarId?: AvatarId;
  } = {};
  if ("displayName" in value) {
    if (
      typeof value.displayName !== "string" ||
      value.displayName.trim().length < 1 ||
      value.displayName.trim().length > 80
    )
      return { problem: problems.displayName };
    changes.displayName = value.displayName.trim();
  }
  if ("bio" in value) {
    if (
      value.bio !== null &&
      (typeof value.bio !== "string" || value.bio.length > 500)
    )
      return { problem: problems.bio };
    changes.bio = value.bio;
  }
  if ("publicationState" in value) {
    if (
      value.publicationState !== "draft" &&
      value.publicationState !== "published"
    )
      return { problem: problems.publicationState };
    changes.publicationState = value.publicationState;
  }
  if ("avatarId" in value) {
    if (!isAvatarId(value.avatarId)) return { problem: problems.avatarId };
    changes.avatarId = value.avatarId;
  }
  return { value: changes };
}

function uniqueViolation(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "23505"
  )
    return null;
  // public_profiles_handle_key versus public_profiles_user_id_key.
  return "constraint" in error &&
    typeof error.constraint === "string" &&
    error.constraint.includes("user_id")
    ? "profile"
    : "handle";
}

export type ExportSources = {
  signInMethods?: (
    userId: string,
  ) => Promise<readonly { method: string; email: string; linkedAt: Date }[]>;
};

export function createIdentityRouter({
  identity,
  recordProductAction,
  exportSources = {},
  now = () => new Date(),
}: {
  identity: Repository;
  recordProductAction?: ProductActionRecorder;
  exportSources?: ExportSources;
  now?: () => Date;
}) {
  const router = Router();
  const requireParticipant = createRequireRole(identity, ["participant"]);
  const requireUnrestricted = createRequireUnrestricted(identity);
  router.use((_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/profile", async (request, response) => {
    const profile = await identity.getProfile(request.user!.id);
    return profile
      ? response.json({ profile })
      : response.status(404).json({ error: "profile not found" });
  });
  router.post(
    "/profile",
    requireParticipant,
    requireUnrestricted,
    async (request, response) => {
      const input = profileInput(request.body);
      if ("problem" in input) return invalid(response, input.problem);
      // A new account confirms the minimum age and accepts the terms first.
      if (!input.value.acceptTerms) return invalid(response, problems.terms);
      try {
        const profile = await identity.createProfile(
          request.user!.id,
          input.value.handle,
          input.value.displayName,
          input.value.bio,
          input.value.publicationState,
          { version: TERMS_VERSION, minimumAge: MINIMUM_AGE },
          input.value.avatarId,
        );
        return response.status(201).json({ profile });
      } catch (error) {
        const duplicate = uniqueViolation(error);
        if (duplicate === "handle")
          return response.status(409).json({
            error: "That handle is taken. Try another.",
            code: "handle_taken",
            field: "handle",
          });
        if (duplicate === "profile")
          return response.status(409).json({
            error: "You already have a profile.",
            code: "profile_exists",
          });
        throw error;
      }
    },
  );
  router.patch("/profile", requireParticipant, async (request, response) => {
    const changes = profileChanges(request.body);
    if ("problem" in changes) return invalid(response, changes.problem);
    const current = await identity.getProfile(request.user!.id);
    if (!current)
      return response.status(404).json({ error: "profile not found" });
    if (current.publicationState === "hidden")
      return response.status(403).json({
        error:
          "Your profile is restricted by moderation. Contact support before changing it.",
      });
    // A restricted account can still make its profile private, and nothing else.
    const keys = Object.keys(changes.value);
    if (keys.length !== 1 || changes.value.publicationState !== "draft") {
      const restriction = await identity.restriction(request.user!.id);
      if (restriction) return restricted(response, restriction);
    }
    const content = textProblem(changes.value, current);
    if (content) return invalid(response, content);
    const profile = await identity.updateProfile(
      request.user!.id,
      changes.value,
    );
    return profile
      ? response.json({ profile })
      : response.status(409).json({
          error: "Your profile couldn't be saved. Refresh and try again.",
        });
  });

  // Whether a handle can still be claimed. Requires a session, so it cannot be
  // used to list drafts anonymously.
  router.get("/handles/:handle", async (request, response) => {
    const handle = request.params.handle;
    if (typeof handle !== "string" || !handlePattern.test(handle))
      return response.json({ handle, available: false, reason: "invalid" });
    if (isReservedName(handle))
      return response.json({ handle, available: false, reason: "reserved" });
    const taken = await identity.isHandleTaken(handle);
    return response.json({
      handle,
      available: !taken,
      ...(taken ? { reason: "taken" } : {}),
    });
  });

  // Decision 0002: one download of the account's own nonfinancial records.
  router.get("/export", async (request, response) => {
    const user = request.user!;
    const [data, methods] = await Promise.all([
      identity.exportData(user.id),
      exportSources.signInMethods?.(user.id) ?? [],
    ]);
    const exportedAt = now();
    response
      .type("application/json")
      .attachment(
        `yaparena-account-${exportedAt.toISOString().slice(0, 10)}.json`,
      );
    return response.send(
      JSON.stringify(
        {
          exportedAt: exportedAt.toISOString(),
          account: {
            id: user.id,
            createdAt: user.createdAt,
            signInMethods: methods.map(({ method, email, linkedAt }) => ({
              method,
              email,
              linkedAt,
            })),
          },
          ...data,
          notIncluded:
            "Chat messages, reports, debate participation and Yap Coins records are not part of this download yet.",
        },
        null,
        2,
      ),
    );
  });

  router.get("/roles", async (request, response) =>
    response.json({ roles: await identity.getRoles(request.user!.id) }),
  );
  router.get("/follows", async (request, response) => {
    const page = pagination(request.query);
    if (!page)
      return response
        .status(400)
        .json({ error: "invalid pagination parameters" });
    return response.json(
      await identity.listFollows(request.user!.id, page.limit, page.offset),
    );
  });
  router.get("/activity", async (request, response) => {
    const page = pagination(request.query);
    if (!page)
      return response
        .status(400)
        .json({ error: "invalid pagination parameters" });
    return response.json(
      await identity.listActivity(request.user!.id, page.limit, page.offset),
    );
  });
  for (const [route, type] of [
    ["/topics/:slug", "topic"],
    ["/people/:slug", "profile"],
  ] as const) {
    router.get(`/follows${route}`, async (request, response) => {
      const slug = request.params.slug;
      if (
        typeof slug !== "string" ||
        !(type === "topic" ? topicPattern : handlePattern).test(slug)
      )
        return response.status(404).json({ error: "resource not found" });
      return response.json({
        following: await identity.isFollowing(request.user!.id, type, slug),
      });
    });
    router.put(
      `/follows${route}`,
      requireParticipant,
      requireUnrestricted,
      async (request, response) => {
        const slug = request.params.slug;
        if (
          typeof slug !== "string" ||
          !(type === "topic" ? topicPattern : handlePattern).test(slug)
        )
          return response.status(404).json({ error: "resource not found" });
        const result = await identity.follow(request.user!.id, type, slug);
        if (result === "missing")
          return response.status(404).json({ error: "resource not found" });
        if (result === "self")
          return response
            .status(409)
            .json({ error: "cannot follow your own profile" });
        if (result === "created")
          await recordProductAction?.(request, {
            type: "follow_created",
            targetType: type,
            slug,
          });
        return response.status(result === "created" ? 201 : 204).end();
      },
    );
    router.delete(
      `/follows${route}`,
      requireParticipant,
      async (request, response) => {
        const slug = request.params.slug;
        if (
          typeof slug !== "string" ||
          !(type === "topic" ? topicPattern : handlePattern).test(slug)
        )
          return response.status(404).json({ error: "resource not found" });
        await identity.unfollow(request.user!.id, type, slug);
        return response.status(204).end();
      },
    );
  }
  return router;
}

function restricted(response: Response, restriction: { expiresAt: Date }) {
  return response.status(403).json({
    error:
      "Your account is restricted by moderation for now. See My reports and appeals.",
    code: "account_restricted",
    restrictedUntil: restriction.expiresAt,
  });
}

/**
 * Refuses a write while the account has an active community restriction (YA-07). Chat, likes and
 * reports check the same restriction inside their own transactions.
 */
export function createRequireUnrestricted(
  identity: Pick<Repository, "restriction">,
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (!request.user)
      return response.status(401).json({ error: "authentication required" });
    const restriction = await identity.restriction(request.user.id);
    if (restriction) return restricted(response, restriction);
    return next();
  };
}

export function createRequireRole(
  identity: Pick<Repository, "getRoles">,
  allowed: readonly string[],
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (!request.user)
      return response.status(401).json({ error: "authentication required" });
    const roles = await identity.getRoles(request.user.id);
    if (!roles.some((role) => allowed.includes(role))) {
      return response.status(403).json({ error: "insufficient role" });
    }
    return next();
  };
}
