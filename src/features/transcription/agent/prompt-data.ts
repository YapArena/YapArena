// YA-05: untrusted text in the outline prompts. A participant writes the
// proposition, debaters' speech becomes the transcript, and earlier labels
// are model output steered by both, so each is passed as data in its own
// tagged section. The system prompts say that everything inside the tags is
// data, never instructions. Here the text is made unable to open or close a
// section: angle brackets become angle quotes, and control and format
// characters (bidi overrides, zero-width and invisible tag characters) go.

import type { TurnOutline } from "../../outline/reducer.ts";
import type { MapEntry } from "./outline-loop.ts";

const hidden = /[\p{Cc}\p{Cf}]/gu;
const angles: Readonly<Record<string, string>> = { "<": "‹", ">": "›" };

/** Text that cannot break out of its data section. */
export function promptData(text: string) {
  return text
    .replace(hidden, (character) =>
      character === "\n"
        ? "\n"
        : character === "\t" || character === "\r"
          ? " "
          : "",
    )
    .replace(/[<>]/g, (character) => angles[character] ?? character);
}

/** A label or point on one line, in double quotes. */
export function quoted(text: string) {
  return JSON.stringify(promptData(text));
}

/** One tagged data section; `empty` stands in for no text. */
export function dataSection(tag: string, text: string, empty = "(none)") {
  return `<${tag}>\n${promptData(text) || empty}\n</${tag}>`;
}

/** The debate map as data lines: ID, turn, side and quoted label. */
export function mapLines(map: readonly MapEntry[]) {
  return map
    .map(
      (entry) =>
        `- ${entry.id} (turn ${entry.turnNumber}, side ${entry.side}): ${quoted(entry.label)}`,
    )
    .join("\n");
}

/** A turn's outline as data lines: IDs, quoted labels and points. */
export function outlineLines(outline: TurnOutline) {
  return outline.arguments
    .map(
      (item) =>
        `${item.id} ${quoted(item.label)}${item.rebuts ? ` (rebuts ${item.rebuts})` : ""}${item.points
          .map((point) => `\n  ${point.id} ${quoted(point.text)}`)
          .join("")}`,
    )
    .join("\n");
}
