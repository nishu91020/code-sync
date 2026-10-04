import type { YUser } from "./identity";

const STYLE_ELEMENT_ID = "codesync-remote-cursors";

/**
 * Base rules shared by every remote caret. Per-client colour rules are appended
 * on top of these whenever the set of collaborators changes.
 */
const BASE_STYLES = `
.yRemoteSelection {
  opacity: 0.5;
  border-radius: 2px;
}
.yRemoteSelectionHead {
  position: absolute;
  box-sizing: border-box;
  height: 100%;
  border-left: 2px solid;
  pointer-events: none;
}
.yRemoteSelectionHead::after {
  position: absolute;
  content: "";
  top: -1.05em;
  left: -2px;
  padding: 0 4px;
  border-radius: 3px 3px 3px 0;
  font-size: 11px;
  line-height: 1.4;
  font-family: var(--font-geist-sans, system-ui, sans-serif);
  white-space: nowrap;
  color: #ffffff;
  pointer-events: none;
  user-select: none;
  opacity: 0;
  transition: opacity 120ms ease-in-out;
}
.monaco-editor:hover .yRemoteSelectionHead::after {
  opacity: 1;
}
`;

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/** Strips any characters that could break out of a CSS colour value. */
function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : "#30bced";
}

function styleElement(): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;

  let element = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement("style");
    element.id = STYLE_ELEMENT_ID;
    document.head.appendChild(element);
  }
  return element;
}

/**
 * Regenerates the colour rules used by y-monaco's remote selection decorations.
 * y-monaco tags each decoration with a `-<clientId>` suffixed class but has no
 * opinion about colour, so the styling has to be driven from awareness state.
 */
export function applyRemoteCursorStyles(peers: ReadonlyMap<number, YUser>): void {
  const element = styleElement();
  if (!element) return;

  const rules = Array.from(peers.entries()).map(([clientId, user]) => {
    const color = safeColor(user.color);
    return `
.yRemoteSelection-${clientId} { background-color: ${color}; }
.yRemoteSelectionHead-${clientId} { border-left-color: ${color}; }
.yRemoteSelectionHead-${clientId}::after {
  background-color: ${color};
  content: "${escapeCssString(user.name)}";
}`;
  });

  element.textContent = `${BASE_STYLES}${rules.join("")}`;
}

export function clearRemoteCursorStyles(): void {
  const element = typeof document === "undefined" ? null : document.getElementById(STYLE_ELEMENT_ID);
  element?.remove();
}
