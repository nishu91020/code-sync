"use client";

import { Button, CircularProgress, TextField, Typography } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";

import { getIdentity, getStoredIdentity, saveIdentityName } from "@/lib/identity";
import { ApiError, roomApi, saveRoomCredential, type RoomCredential } from "@/lib/roomAccess";

const POLL_MS = 1500;

type Stage =
  | { kind: "form" }
  | { kind: "waiting"; requestId: string; secret: string }
  | { kind: "denied" };

/**
 * The guest side of admission. A guest asks to join, then waits until the
 * host admits or declines them. Only an admitted guest receives a credential;
 * nothing in the room is reachable before that.
 */
export const JoinRoom = ({
  roomId,
  notice,
  onAdmitted,
}: {
  roomId: string;
  notice?: string | null;
  onAdmitted: (credential: RoomCredential) => void;
}) => {
  const [name, setName] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A name typed on the home page carries over; otherwise the guest must say
  // who they are, since that is what the host decides on.
  useEffect(() => {
    setName(getStoredIdentity()?.name ?? "");
  }, []);

  const ask = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    setSubmitting(true);
    try {
      const identity = saveIdentityName(trimmed);
      const { requestId, requestSecret } = await roomApi.requestToJoin(
        roomId,
        trimmed,
        identity.color,
      );
      setStage({ kind: "waiting", requestId, secret: requestSecret });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your request");
    } finally {
      setSubmitting(false);
    }
  };

  // Withdraw a request the guest walks away from, so the host does not see it.
  const pendingRef = useRef<{ requestId: string; secret: string } | null>(null);
  useEffect(() => {
    pendingRef.current = stage.kind === "waiting" ? stage : null;
  }, [stage]);
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (pending) roomApi.cancelRequest(roomId, pending.requestId, pending.secret).catch(() => {});
    },
    [roomId],
  );

  const cancel = useCallback(async () => {
    if (stage.kind !== "waiting") return;
    await roomApi.cancelRequest(roomId, stage.requestId, stage.secret).catch(() => {});
    setStage({ kind: "form" });
  }, [roomId, stage]);

  useEffect(() => {
    if (stage.kind !== "waiting") return;
    let stopped = false;

    const check = async () => {
      try {
        const decision = await roomApi.pollRequest(roomId, stage.requestId, stage.secret);
        if (stopped) return;
        if (decision.status === "admitted") {
          pendingRef.current = null;
          const credential: RoomCredential = {
            token: decision.token,
            role: "member",
            name: decision.name,
          };
          saveRoomCredential(roomId, credential);
          onAdmitted(credential);
        } else if (decision.status === "denied") {
          pendingRef.current = null;
          setStage({ kind: "denied" });
        }
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && err.status === 404) {
          pendingRef.current = null;
          setError("Your request expired. You can ask again.");
          setStage({ kind: "form" });
        }
        // Other failures are transient; keep polling.
      }
    };

    check();
    const id = setInterval(check, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [roomId, stage, onAdmitted]);

  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <Typography variant="h4" sx={{ fontWeight: "bold" }}>
          Join room
        </Typography>
        <Typography variant="body2" className="font-mono text-gray-500">
          {roomId}
        </Typography>
      </div>

      {notice && stage.kind === "form" && (
        <p className="max-w-sm rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {notice}
        </p>
      )}

      {stage.kind === "form" && (
        <div className="flex w-full max-w-sm flex-col gap-4">
          <p className="text-sm text-gray-500">
            This room is private. The host has to let you in.
          </p>
          <TextField
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
            }}
            error={Boolean(error)}
            helperText={error ?? "The host sees this name when you ask to join"}
            slotProps={{ htmlInput: { maxLength: 32 } }}
            fullWidth
            autoFocus
            required
          />
          <Button
            variant="contained"
            size="large"
            onClick={ask}
            disabled={submitting || !name.trim()}
          >
            {submitting ? "Asking…" : "Ask to join"}
          </Button>
        </div>
      )}

      {stage.kind === "waiting" && (
        <div className="flex w-full max-w-sm flex-col items-center gap-4" data-testid="waiting-for-host">
          <CircularProgress size={28} />
          <p className="font-medium">Waiting for the host to let you in…</p>
          <p className="text-sm text-gray-500">
            You asked to join as <strong>{name.trim() || getIdentity().name}</strong>. The host needs
            to have this room open to see your request.
          </p>
          <Button variant="text" onClick={cancel}>
            Cancel request
          </Button>
        </div>
      )}

      {stage.kind === "denied" && (
        <div className="flex w-full max-w-sm flex-col items-center gap-4" data-testid="join-denied">
          <p className="font-medium text-red-600">The host declined your request.</p>
          <Button variant="outlined" onClick={() => setStage({ kind: "form" })}>
            Ask again
          </Button>
        </div>
      )}
    </main>
  );
};

export default JoinRoom;
