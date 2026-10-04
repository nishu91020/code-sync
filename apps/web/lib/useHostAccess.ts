"use client";

import { useCallback, useEffect, useState } from "react";

import { roomApi, type Member, type PendingRequest } from "./roomAccess";

const POLL_MS = 2000;

export type HostAccess = {
  pending: PendingRequest[];
  members: Member[];
  error: string | null;
  admit: (requestId: string) => Promise<void>;
  deny: (requestId: string) => Promise<void>;
  remove: (memberId: string) => Promise<void>;
};

/**
 * The host's view of who is waiting and who is in. Only the host token can
 * read this; for anyone else `enabled` is false and nothing is fetched.
 */
export function useHostAccess(roomId: string, token: string, enabled: boolean): HostAccess {
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await roomApi.listAccess(roomId, token);
      setPending(list.pending);
      setMembers(list.members);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load join requests");
    }
  }, [roomId, token]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refresh]);

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : "That did not work");
      }
      await refresh();
    },
    [refresh],
  );

  return {
    pending,
    members,
    error,
    admit: (requestId) => act(() => roomApi.admit(roomId, requestId, token)),
    deny: (requestId) => act(() => roomApi.deny(roomId, requestId, token)),
    remove: (memberId) => act(() => roomApi.removeMember(roomId, memberId, token)),
  };
}
