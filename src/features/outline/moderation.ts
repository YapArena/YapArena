// Decision 0012: slurs and insults never appear in the public AI outline. The
// model is told not to reproduce them; this check is the server's backstop
// when it resolves live proposals and window cleanups. French and English
// terms are kept base64-encoded so the source is not a plain list of slurs.
// Matching is on whole words after removing invisible characters, folding
// compatibility forms (full-width or styled letters), removing accents,
// lowercasing, mapping look-alike letters and common character swaps (0→o,
// 1→i, @→a…), on stretched words collapsed ("fuuuck") and on words spelled out
// letter by letter ("f u c k").
//
// YA-05: outline text is model output that debaters can steer with what
// they say and write, so the server also refuses links, email addresses, phone
// numbers and control or format characters (bidi overrides, zero-width and
// invisible tag characters) in labels and points. Meaning is not checked here.

const encoded =
  "WyJhYnJ1dGkiLCAiYXNzaG9sZSIsICJiYW1ib3VsYSIsICJiYXRhcmQiLCAiYmVhbmVyIiwgImJpY290IiwgImJpdGNoIiwgImJvdWdub3VsZSIsICJjaGluZXRvcXVlIiwgImNoaW5rIiwgImNvbm5hcmQiLCAiY29ubmFzc2UiLCAiY29ubmUiLCAiY29vbiIsICJjcmV0aW4iLCAiY3VudCIsICJkZWJpbGUiLCAiZGlja2hlYWQiLCAiZHVtYmFzcyIsICJkeWtlIiwgImVuY3VsZSIsICJlbmN1bGVlIiwgImZhZyIsICJmYWdnb3QiLCAiZmlscyBkZSBwdXRlIiwgImZ1Y2siLCAiZnVja2VyIiwgImZ1Y2tpbmciLCAiZ29nb2wiLCAiZ29vayIsICJnb3VpbmUiLCAiZ3JvZ25hc3NlIiwgImlkaW90IiwgImltYmVjaWxlIiwgImphY2thc3MiLCAia2lrZSIsICJtb3JvbiIsICJtb3RoZXJmdWNrZXIiLCAibmVncmUiLCAibmVncmVzc2UiLCAibmlnZ2EiLCAibmlnZ2VyIiwgIm5pcXVlIHRhIG1lcmUiLCAicGFraSIsICJwZWRlIiwgInBvdWZmaWFzc2UiLCAicHJpY2siLCAicHV0YWluIiwgInB1dGUiLCAicmFnaGVhZCIsICJyZXRhcmQiLCAicmV0YXJkZWQiLCAic2FsZSBhcmFiZSIsICJzYWxlIGp1aWYiLCAic2FsZSBub2lyIiwgInNhbG9wZSIsICJzY3VtYmFnIiwgInNoaXRoZWFkIiwgInNsdXQiLCAic3BpYyIsICJ0YSBndWV1bGUiLCAidGFmaW9sZSIsICJ0YXBldHRlIiwgInRhcmxvdXplIiwgInRldGUgZGUgY29uIiwgInRvd2VsaGVhZCIsICJ0cmFubnkiLCAidHdhdCIsICJ3YW5rZXIiLCAid2V0YmFjayIsICJ3aG9yZSIsICJ5b3VwaW4iLCAieW91dHJlIl0=";

/** Control and format characters: bidi overrides, zero-width, invisible tags. */
const hiddenCharacters = /[\p{Cc}\p{Cf}]/u;
const swaps: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
};
/** Lowercase Cyrillic, Greek and IPA letters drawn like Latin ones. */
const lookalikes: Readonly<Record<string, string>> = {
  а: "a",
  с: "c",
  ԁ: "d",
  е: "e",
  һ: "h",
  і: "i",
  ј: "j",
  к: "k",
  ӏ: "l",
  о: "o",
  р: "p",
  ԛ: "q",
  ѕ: "s",
  у: "y",
  ԝ: "w",
  х: "x",
  α: "a",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ı: "i",
  ɑ: "a",
  ɡ: "g",
};
const lookalike = new RegExp(`[${Object.keys(lookalikes).join("")}]`, "gu");
/** Lowercase, accent-free words with look-alikes and character swaps undone. */
export function moderationWords(text: string) {
  return text
    .replace(new RegExp(hiddenCharacters.source, "gu"), "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(lookalike, (character) => lookalikes[character] ?? character)
    .replace(
      /[013457@$]|!(?=\p{L})/gu,
      (character) => swaps[character] ?? character,
    )
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
}
const collapse = (word: string) => word.replace(/(\p{L})\1+/gu, "$1");

const terms = (JSON.parse(atob(encoded)) as string[]).map((term) =>
  moderationWords(term),
);
const single = new Set<string>();
const stretched = new Set<string>();
const phrases: string[][] = [];
for (const words of terms) {
  if (words.length === 1) {
    single.add(words[0]!);
    stretched.add(collapse(words[0]!));
  } else phrases.push(words);
}
// Only a word with a letter repeated three times or more counts as stretched,
// so ordinary double letters never collapse into a blocked term.
const isStretched = (word: string) => /(\p{L})\1\1/u.test(word);
const blockedWord = (word: string) =>
  single.has(word) || (isStretched(word) && stretched.has(collapse(word)));

/**
 * Words spelled out letter by letter ("f u c k", "f.u.c.k"): every stretch of
 * three or more consecutive one-letter words, joined.
 */
function spelledOut(words: readonly string[]) {
  const joined: string[] = [];
  let run: string[] = [];
  const flush = () => {
    for (let start = 0; start + 3 <= run.length; start++)
      for (let end = start + 3; end <= run.length; end++)
        joined.push(run.slice(start, end).join(""));
    run = [];
  };
  for (const word of words) {
    if (word.length === 1) run.push(word);
    else flush();
  }
  flush();
  return joined;
}

/** True when the text contains a blocked French or English term. */
export function containsBlockedTerm(text: string) {
  const words = moderationWords(text);
  if (words.some(blockedWord) || spelledOut(words).some(blockedWord))
    return true;
  return phrases.some((phrase) =>
    words.some((_, start) =>
      phrase.every((part, offset) => words[start + offset] === part),
    ),
  );
}

const email = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
// A scheme ("https://"), "www." or a host name ending in a common top-level
// domain, including link shorteners ("bit.ly", "t.me").
const link = new RegExp(
  [
    String.raw`\b[a-z][a-z0-9+.-]{1,30}:\/\/`,
    String.raw`\bwww\d{0,3}\.`,
    String.raw`(?<![\p{L}\p{N}-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:${[
      "ai",
      "app",
      "be",
      "biz",
      "blog",
      "ca",
      "cc",
      "ch",
      "club",
      "cn",
      "co",
      "com",
      "de",
      "dev",
      "edu",
      "eu",
      "fm",
      "fr",
      "gg",
      "gl",
      "gov",
      "info",
      "io",
      "link",
      "live",
      "ly",
      "me",
      "net",
      "news",
      "onion",
      "online",
      "org",
      "page",
      "quebec",
      "ru",
      "sh",
      "shop",
      "site",
      "store",
      "to",
      "top",
      "tv",
      "uk",
      "ws",
      "xyz",
    ].join("|")})(?![\p{L}\p{N}-])`,
  ].join("|"),
  "iu",
);
// Runs of digit groups as phone numbers are written: "514-555-0199",
// "(514) 555 0199", "+33 6 12 34 56 78", "06.12.34.56.78", "5145550199".
const phoneCandidates =
  /(?<!\p{N})(?:\+\s?\d{1,3}(?:\s?[.\-–/]\s?|\s)?)?(?:\(\d{1,4}\)\s?[.\-–/]?\s?)?\d{1,4}(?:(?:\s?[.\-–/]\s?|\s)\d{1,4}){1,6}(?!\p{N})|\+?\d{9,15}(?!\p{N})/gu;
// Large numbers grouped by thousands ("2 500 000", "1.000.000") and lists of
// years ("1990 2000 2010") are not phone numbers.
const thousands = /^\d{1,3}(?:[\s.]\d{3})+$/u;
const years = /^(?:1\d{3}|2\d{3})(?:\s?[\s.\-–/]\s?(?:1\d{3}|2\d{3}))*$/u;
function containsPhoneNumber(text: string) {
  for (const [candidate] of text.matchAll(phoneCandidates)) {
    const digits = candidate.replace(/\D/g, "").length;
    if (digits < 9 || digits > 15) continue;
    if (/[+(]/.test(candidate)) return true;
    if (!thousands.test(candidate) && !years.test(candidate)) return true;
  }
  return false;
}

export type OutlineTextProblem =
  "hidden_character" | "email" | "link" | "phone" | "blocked_term";

/** Why outline text must not be published, or null when it may be. */
export function outlineTextProblem(text: string): OutlineTextProblem | null {
  if (hiddenCharacters.test(text)) return "hidden_character";
  if (email.test(text)) return "email";
  if (link.test(text)) return "link";
  if (containsPhoneNumber(text)) return "phone";
  if (containsBlockedTerm(text)) return "blocked_term";
  return null;
}

/** The server's check on every outline label and point it stores. */
export function acceptOutlineText(text: string) {
  return outlineTextProblem(text) === null;
}
