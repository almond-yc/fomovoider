// Minimal parser for WebDriverAgent's XML page source: every element with
// its type, accessibility name/label/value, frame, and children.

export type Node = {
  type: string;
  name?: string;
  label?: string;
  value?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  children: Node[];
  parent?: Node;
};

const TAG = /<(\/?)(XCUIElementType\w+|AppiumAUT)([^>]*?)(\/?)>/g;
const ATTR = /(\w+)="([^"]*)"/g;

function unescape(s: string) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

export function parseSource(xml: string): Node {
  const root: Node = { type: "root", x: 0, y: 0, width: 0, height: 0, visible: true, children: [] };
  const stack: Node[] = [root];
  for (const m of xml.matchAll(TAG)) {
    const [, closing, tag, attrText, selfClosing] = m;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText.matchAll(ATTR)) attrs[a[1]] = unescape(a[2]);
    const parent = stack[stack.length - 1];
    const node: Node = {
      type: tag.replace("XCUIElementType", ""),
      name: attrs.name,
      label: attrs.label,
      value: attrs.value,
      x: Number(attrs.x ?? 0),
      y: Number(attrs.y ?? 0),
      width: Number(attrs.width ?? 0),
      height: Number(attrs.height ?? 0),
      visible: attrs.visible !== "false",
      children: [],
      parent,
    };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

export function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

export function find(root: Node, pred: (n: Node) => boolean) {
  for (const n of walk(root)) if (pred(n)) return n;
  return undefined;
}

export function findAll(root: Node, pred: (n: Node) => boolean) {
  return [...walk(root)].filter(pred);
}

export function text(n: Node) {
  return n.label || n.name || n.value || "";
}

// Every visible string on screen, for tripwire checks and debugging.
export function allText(root: Node) {
  return findAll(root, (n) => n.visible && !!text(n)).map(text).join("\n");
}
