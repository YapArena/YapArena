// Decision 0012: slurs and insults never appear in the public AI outline. The
// model is told not to reproduce them; this check is the server's backstop
// (the agent runs it too, before sending). French and English terms are kept
// base64-encoded so the source is not a plain list of slurs. Matching is on
// whole words after lowercasing, removing accents, mapping common character
// swaps (0→o, 1→i, @→a…), and on stretched words collapsed ("fuuuck").

const encoded =
  "WyJhYnJ1dGkiLCAiYXNzaG9sZSIsICJiYW1ib3VsYSIsICJiYXRhcmQiLCAiYmVhbmVyIiwgImJpY290IiwgImJpdGNoIiwgImJvdWdub3VsZSIsICJjaGluZXRvcXVlIiwgImNoaW5rIiwgImNvbm5hcmQiLCAiY29ubmFzc2UiLCAiY29ubmUiLCAiY29vbiIsICJjcmV0aW4iLCAiY3VudCIsICJkZWJpbGUiLCAiZGlja2hlYWQiLCAiZHVtYmFzcyIsICJkeWtlIiwgImVuY3VsZSIsICJlbmN1bGVlIiwgImZhZyIsICJmYWdnb3QiLCAiZmlscyBkZSBwdXRlIiwgImZ1Y2siLCAiZnVja2VyIiwgImZ1Y2tpbmciLCAiZ29nb2wiLCAiZ29vayIsICJnb3VpbmUiLCAiZ3JvZ25hc3NlIiwgImlkaW90IiwgImltYmVjaWxlIiwgImphY2thc3MiLCAia2lrZSIsICJtb3JvbiIsICJtb3RoZXJmdWNrZXIiLCAibmVncmUiLCAibmVncmVzc2UiLCAibmlnZ2EiLCAibmlnZ2VyIiwgIm5pcXVlIHRhIG1lcmUiLCAicGFraSIsICJwZWRlIiwgInBvdWZmaWFzc2UiLCAicHJpY2siLCAicHV0YWluIiwgInB1dGUiLCAicmFnaGVhZCIsICJyZXRhcmQiLCAicmV0YXJkZWQiLCAic2FsZSBhcmFiZSIsICJzYWxlIGp1aWYiLCAic2FsZSBub2lyIiwgInNhbG9wZSIsICJzY3VtYmFnIiwgInNoaXRoZWFkIiwgInNsdXQiLCAic3BpYyIsICJ0YSBndWV1bGUiLCAidGFmaW9sZSIsICJ0YXBldHRlIiwgInRhcmxvdXplIiwgInRldGUgZGUgY29uIiwgInRvd2VsaGVhZCIsICJ0cmFubnkiLCAidHdhdCIsICJ3YW5rZXIiLCAid2V0YmFjayIsICJ3aG9yZSIsICJ5b3VwaW4iLCAieW91dHJlIl0=";

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
/** Lowercase, accent-free words with common character swaps undone. */
export function moderationWords(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
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

/** True when the text contains a blocked French or English term. */
export function containsBlockedTerm(text: string) {
  const words = moderationWords(text);
  if (
    words.some(
      (word) =>
        single.has(word) ||
        (isStretched(word) && stretched.has(collapse(word))),
    )
  )
    return true;
  return phrases.some((phrase) =>
    words.some((_, start) =>
      phrase.every((part, offset) => words[start + offset] === part),
    ),
  );
}
