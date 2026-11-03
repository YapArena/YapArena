// Rules for text people publish: handles, usernames, bios, topics, propositions and chat.
// They apply when text is written; rows saved before them are left as they are.

// Control and format characters: NUL, bidirectional overrides and isolates, zero-width
// spaces and joiners, soft hyphens, and the invisible line and paragraph separators.
const hiddenCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// A zero-width joiner between two pictographs builds one emoji, such as 🏳️‍🌈 or 👩🏽‍💻.
const emojiJoiner =
  /(?<=\p{Extended_Pictographic}\u{FE0F}?[\u{1F3FB}-\u{1F3FF}]?)‍(?=\p{Extended_Pictographic})/gu;
// Line breaks and tabs belong in multi-line text such as a bio or a chat message.
const lineWhitespace = /[\t\n\r]/g;

/** Whether text contains a control or invisible formatting character. */
export function hasHiddenCharacters(
  value: string,
  { multiline = false }: { multiline?: boolean } = {},
) {
  const visible = value.replace(emojiJoiner, "");
  return hiddenCharacter.test(
    multiline ? visible.replace(lineWhitespace, "") : visible,
  );
}

// Whole names, compared in lowercase without separators or trailing digits ("Mod-1" is "mod").
const reservedNames = new Set([
  "abuse",
  "account",
  "accounts",
  "admin",
  "administrator",
  "administrators",
  "admins",
  "anonymous",
  "api",
  "billing",
  "contact",
  "everyone",
  "founder",
  "help",
  "helpdesk",
  "hostmaster",
  "info",
  "legal",
  "mod",
  "moderation",
  "moderator",
  "moderators",
  "mods",
  "noreply",
  "null",
  "official",
  "operator",
  "operators",
  "owner",
  "participant",
  "postmaster",
  "privacy",
  "root",
  "safety",
  "security",
  "staff",
  "support",
  "system",
  "team",
  "trust",
  "trustandsafety",
  "undefined",
  "verified",
  "webmaster",
  "www",
  "yap",
  "yaparena",
]);
// Words that make a name look official wherever they appear, as in "the-moderator".
const staffWords = new Set([
  "admin",
  "administrator",
  "administrators",
  "admins",
  "moderator",
  "moderators",
  "official",
  "staff",
  "yaparena",
]);

/** Whether a handle or username would pass for YAP Arena staff or the service itself. */
export function isReservedName(value: string) {
  const words = value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.replace(/\d+$/, ""));
  const joined = words.join("");
  return (
    reservedNames.has(joined) ||
    words.some((word) => staffWords.has(word)) ||
    joined.includes("yaparena")
  );
}
