"use client";

import { API_URL } from "./config";

export type RoomRole = "host" | "member";

/** A room credential: a secret token, the role it grants, and whose it is. */
export type RoomCredential = { token: string; role: RoomRole; name?: string };

export type AccessDecision =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "admitted"; token: string; memberId: string; name: string };

export type PendingRequest = { id: string; name: string; color: string | null; requestedAt: number };
export type Member = { id: string; name: string; admittedAt: string };
export type RoomAccessList = { host: { name: string }; pending: PendingRequest[]; members: Member[] };

/** An HTTP failure, keeping the status so callers can tell "no access" apart. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/*
 * Credentials are kept at two levels:
 *
 * - The credential a tab is *using* lives in sessionStorage, so each tab is its
 *   own participant (matching the per-tab name and cursor colour) and a reload
 *   keeps it. Sharing it across tabs made a second tab silently enter as the
 *   host, skipping both the name prompt and the host's approval.
 * - Every credential this browser has been given for a room is also
 *   *remembered* in localStorage, so a new tab can offer "Continue as …"
 *   (the host must never be locked out of their own room by closing a tab).
 */
const tabKey = (roomId: string) => `codesync:room:${roomId}`;
const rememberedKey = (roomId: string) => `codesync:rooms:${roomId}`;
const MAX_REMEMBERED = 5;

function parseCredential(value: unknown): RoomCredential | null {
  if (!value || typeof value !== "object") return null;
  const { token, role, name } = value as Record<string, unknown>;
  if (typeof token !== "string" || (role !== "host" && role !== "member")) return null;
  return { token, role, ...(typeof name === "string" ? { name } : {}) };
}

function read(storage: Storage, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: unknown): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage the credential only lasts for this page view.
  }
}

/** The credential this tab is using for the room, if any. */
export function getTabCredential(roomId: string): RoomCredential | null {
  if (typeof window === "undefined") return null;
  return parseCredential(read(window.sessionStorage, tabKey(roomId)));
}

/** Every credential this browser remembers for the room, newest first. */
export function getRememberedCredentials(roomId: string): RoomCredential[] {
  if (typeof window === "undefined") return [];
  const stored = read(window.localStorage, rememberedKey(roomId));
  const list = (Array.isArray(stored) ? stored : []).map(parseCredential).filter(Boolean) as RoomCredential[];

  // Before per-tab credentials, one credential per room sat under the tab key
  // in localStorage. Fold it into the remembered list once.
  const legacy = parseCredential(read(window.localStorage, tabKey(roomId)));
  if (legacy) {
    write(window.localStorage, tabKey(roomId), null);
    if (!list.some((entry) => entry.token === legacy.token)) list.push(legacy);
    write(window.localStorage, rememberedKey(roomId), list);
  }
  return list;
}

/** Makes `credential` this tab's identity in the room, and remembers it. */
export function saveRoomCredential(roomId: string, credential: RoomCredential): void {
  write(window.sessionStorage, tabKey(roomId), credential);
  const others = getRememberedCredentials(roomId).filter((entry) => entry.token !== credential.token);
  write(window.localStorage, rememberedKey(roomId), [credential, ...others].slice(0, MAX_REMEMBERED));
}

/** Drops a credential everywhere, e.g. after the host removed that person. */
export function forgetRoomCredential(roomId: string, token: string): void {
  if (getTabCredential(roomId)?.token === token) write(window.sessionStorage, tabKey(roomId), null);
  const remaining = getRememberedCredentials(roomId).filter((entry) => entry.token !== token);
  write(window.localStorage, rememberedKey(roomId), remaining.length ? remaining : null);
}

async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, headers, ...rest } = init;
  const response = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    ...rest,
    headers: {
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(body?.error ?? `Request failed (HTTP ${response.status})`, response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const enc = encodeURIComponent;

const ROOM_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Pulls a room id out of whatever someone pasted: a full invite link
 * (`https://…/room/<id>`), a path, or the bare id. `null` if there is none.
 */
export function parseRoomId(input: string): string | null {
  const match = ROOM_ID_RE.exec(input.trim());
  return match ? match[0].toLowerCase() : null;
}

export const roomApi = {
  create: (name: string) =>
    request<{ roomId: string; hostToken: string }>("/api/room", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  describe: (roomId: string) =>
    request<{ exists: boolean; joinable: boolean }>(`/api/room/${enc(roomId)}`),

  me: (roomId: string, token: string) =>
    request<{ role: RoomRole; name: string; memberId: string | null }>(`/api/room/${enc(roomId)}/me`, {
      token,
    }),

  requestToJoin: (roomId: string, name: string, color: string) =>
    request<{ requestId: string; requestSecret: string }>(`/api/room/${enc(roomId)}/join-requests`, {
      method: "POST",
      body: JSON.stringify({ name, color }),
    }),

  pollRequest: (roomId: string, requestId: string, secret: string) =>
    request<AccessDecision>(`/api/room/${enc(roomId)}/join-requests/${enc(requestId)}`, {
      token: secret,
    }),

  cancelRequest: (roomId: string, requestId: string, secret: string) =>
    request<void>(`/api/room/${enc(roomId)}/join-requests/${enc(requestId)}`, {
      method: "DELETE",
      token: secret,
      keepalive: true,
    }),

  listAccess: (roomId: string, hostToken: string) =>
    request<RoomAccessList>(`/api/room/${enc(roomId)}/access`, { token: hostToken }),

  admit: (roomId: string, requestId: string, hostToken: string) =>
    request<{ memberId: string }>(`/api/room/${enc(roomId)}/join-requests/${enc(requestId)}/admit`, {
      method: "POST",
      token: hostToken,
    }),

  deny: (roomId: string, requestId: string, hostToken: string) =>
    request<void>(`/api/room/${enc(roomId)}/join-requests/${enc(requestId)}/deny`, {
      method: "POST",
      token: hostToken,
    }),

  removeMember: (roomId: string, memberId: string, hostToken: string) =>
    request<void>(`/api/room/${enc(roomId)}/members/${enc(memberId)}`, {
      method: "DELETE",
      token: hostToken,
    }),
};

/** WebSocket close codes the server uses to refuse or end access. */
export const ACCESS_CLOSE_CODES = {
  invalid: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  notFound: 4404,
} as const;

export const isAccessCloseCode = (code: number) => code >= 4400 && code < 4500;
