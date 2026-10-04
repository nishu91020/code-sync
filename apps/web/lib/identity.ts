export type YUser = {
  name: string;
  color: string;
};

const STORAGE_KEY = "codesync:identity";

// Chosen to stay readable against both the light and dark Monaco themes.
const COLORS = [
  "#30bced",
  "#6eeb83",
  "#ffbc42",
  "#ecd444",
  "#ee6352",
  "#9ac2c9",
  "#8acb88",
  "#f0a6ca",
  "#b388eb",
  "#f76f8e",
];

const ADJECTIVES = [
  "Swift",
  "Curious",
  "Bold",
  "Quiet",
  "Clever",
  "Bright",
  "Calm",
  "Eager",
  "Lucky",
  "Nimble",
];

const ANIMALS = [
  "Otter",
  "Falcon",
  "Panda",
  "Lynx",
  "Heron",
  "Badger",
  "Dolphin",
  "Ibex",
  "Magpie",
  "Wolf",
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function createIdentity(): YUser {
  return {
    name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
    color: pick(COLORS),
  };
}

/** A throwaway display name, used to pre-fill the "your name" prompts. */
export function suggestName(): string {
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

function readStored(): YUser | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<YUser>;
    if (typeof parsed.name === "string" && typeof parsed.color === "string") {
      return { name: parsed.name, color: parsed.color };
    }
  } catch {
    // Ignore unreadable or disabled storage.
  }
  return null;
}

function writeStored(identity: YUser): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Storage is optional; the identity just will not survive a reload.
  }
}

/**
 * Returns the identity the user has already chosen, or `null` if they have not
 * picked one yet. Callers use this to decide whether to prompt for a name.
 */
export function getStoredIdentity(): YUser | null {
  return readStored();
}

/**
 * Records the display name the user chose, keeping any colour already assigned
 * to this tab so collaborators do not see it change.
 */
export function saveIdentityName(name: string): YUser {
  const trimmed = name.trim();
  const existing = readStored();
  const identity: YUser = {
    name: trimmed || existing?.name || suggestName(),
    color: existing?.color ?? pick(COLORS),
  };
  writeStored(identity);
  return identity;
}

/**
 * Returns a stable per-tab identity. Reusing the same identity across reloads
 * keeps a user's cursor colour consistent for their collaborators.
 */
export function getIdentity(): YUser {
  if (typeof window === "undefined") {
    return createIdentity();
  }

  const stored = readStored();
  if (stored) return stored;

  const identity = createIdentity();
  writeStored(identity);
  return identity;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
