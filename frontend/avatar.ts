// People's avatars in the browser: the image in a slot, and the picker the
// handle pop-up and Settings share (Decision 0014). The header's
// data-avatar-src holds the versioned address with {id} in place of the id.
import {
  AVATAR_IDS,
  avatarName,
  isAvatarId,
  type AvatarId,
} from "../src/features/identity/avatars.ts";

export { isAvatarId, type AvatarId };

const fallbackTemplate = "/assets/avatars/{id}.svg";

function avatarSrc(id: AvatarId) {
  const template =
    document.querySelector<HTMLElement>("[data-site-header]")?.dataset
      .avatarSrc ?? fallbackTemplate;
  return template.replace("{id}", id);
}

/** The avatar as an image that fills its slot; the name is always beside it. */
export function avatarImage(id: AvatarId) {
  const image = document.createElement("img");
  image.className = "avatar-img";
  image.src = avatarSrc(id);
  image.alt = "";
  image.decoding = "async";
  return image;
}

export function randomAvatarId(): AvatarId {
  return AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)]!;
}

export interface AvatarPicker {
  readonly element: HTMLFieldSetElement;
  value(): AvatarId | null;
  set(id: AvatarId | null): void;
  setDisabled(disabled: boolean): void;
  focus(): void;
}

/**
 * One radio per avatar, drawn as 48 px tiles. Native radios give the arrow
 * keys; each label is the avatar's name.
 */
export function createAvatarPicker({
  name,
  legend,
  selected,
  onChange,
}: {
  name: string;
  legend: string;
  selected: AvatarId | null;
  onChange?: (id: AvatarId) => void;
}): AvatarPicker {
  const element = document.createElement("fieldset");
  element.className = "avatar-picker";
  const title = document.createElement("legend");
  title.textContent = legend;
  const grid = document.createElement("div");
  grid.className = "avatar-picker-grid";
  const inputs = AVATAR_IDS.map((id) => {
    const choice = document.createElement("label");
    choice.className = "avatar-choice";
    choice.title = avatarName(id);
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = id;
    input.checked = input.defaultChecked = id === selected;
    const label = document.createElement("span");
    label.className = "sr-only";
    label.textContent = avatarName(id);
    choice.append(input, avatarImage(id), label);
    grid.append(choice);
    return input;
  });
  element.append(title, grid);
  element.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && isAvatarId(input.value))
      onChange?.(input.value);
  });
  const value = () => {
    const checked = inputs.find((input) => input.checked)?.value;
    return isAvatarId(checked) ? checked : null;
  };
  return {
    element,
    value,
    set(id) {
      for (const input of inputs)
        input.checked = input.defaultChecked = input.value === id;
    },
    setDisabled(disabled) {
      element.disabled = disabled;
    },
    focus() {
      (inputs.find((input) => input.checked) ?? inputs[0])!.focus();
    },
  };
}
