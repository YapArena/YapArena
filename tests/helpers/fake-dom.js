// A small DOM for unit tests of the outline panel: elements with classes,
// datasets, children and the class/attribute selectors the panel uses
// (".a", "[data-x]", ":scope > .a", and comma-free compounds of those).

class FakeClassList {
  constructor(element) {
    this.element = element;
  }
  get values() {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }
  add(...names) {
    const values = this.values;
    for (const name of names) values.add(name);
    this.element.className = [...values].join(" ");
  }
  remove(...names) {
    const values = this.values;
    for (const name of names) values.delete(name);
    this.element.className = [...values].join(" ");
  }
  contains(name) {
    return this.values.has(name);
  }
}

function matches(element, selector) {
  const parts =
    selector.match(/\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|^[a-z]+/g) ?? [];
  return parts.every((part) => {
    if (part.startsWith(".")) return element.classList.contains(part.slice(1));
    if (part.startsWith("[")) {
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
      const key = name
        .replace(/^data-/, "")
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!name.startsWith("data-")) return element.attributes.has(name);
      return value === undefined
        ? key in element.dataset
        : element.dataset[key] === value;
    }
    return element.tagName === part.toUpperCase();
  });
}

export class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.className = "";
    this.hidden = false;
    this.lang = "";
    this.type = "";
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new FakeClassList(this);
    this.ownText = "";
    this.textWrites = 0;
  }
  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join("")
      : this.ownText;
  }
  set textContent(value) {
    this.textWrites++;
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.ownText = String(value);
  }
  get offsetWidth() {
    return 1;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parent)
        node.parent.children = node.parent.children.filter((c) => c !== node);
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  dispatch(type, event = {}) {
    this.listeners.get(type)?.(event);
  }
  click() {
    this.dispatch("click");
  }
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector) {
    if (selector.startsWith(":scope > "))
      return this.children.filter((child) => matches(child, selector.slice(9)));
    return [...this.descendants()].filter((element) =>
      matches(element, selector),
    );
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export function fakeDocument() {
  const listeners = new Map();
  return {
    hidden: false,
    listeners,
    createElement: (tag) => new FakeElement(tag),
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
}

/** The outline panel's markup, as the debate page renders it. */
export function outlinePanel(bootstrap) {
  const root = new FakeElement("section");
  root.className = "live-outline";
  root.dataset.liveOutline = "";
  const turn = new FakeElement("span");
  turn.dataset.liveOutlineTurn = "";
  const list = new FakeElement("ol");
  list.dataset.liveOutlineArguments = "";
  const earlier = new FakeElement("details");
  earlier.dataset.liveOutlineEarlier = "";
  earlier.hidden = true;
  const turns = new FakeElement("ol");
  turns.dataset.liveOutlineTurns = "";
  earlier.append(turns);
  const live = new FakeElement("p");
  live.dataset.liveOutlineAnnounce = "";
  const template = new FakeElement("template");
  template.dataset.liveOutlineState = "";
  template.content = { textContent: JSON.stringify(bootstrap) };
  root.append(turn, list, earlier, live, template);
  return { root, turn, list, earlier, turns, live };
}
