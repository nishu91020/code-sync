"use client";

import { Button, Typography } from "@mui/material";
import { useState } from "react";

import type { RoomCredential } from "@/lib/roomAccess";

/**
 * Shown in a new tab when this browser has been in the room before. Those
 * identities are offered, never assumed: a new tab can just as well be a
 * different person, who then has to ask the host like anyone else.
 */
export const ChooseIdentity = ({
  roomId,
  options,
  notice,
  onContinue,
  onJoinAsSomeoneElse,
}: {
  roomId: string;
  options: RoomCredential[];
  notice: string | null;
  onContinue: (credential: RoomCredential) => Promise<void>;
  onJoinAsSomeoneElse: () => void;
}) => {
  const [busy, setBusy] = useState<string | null>(null);

  const label = (option: RoomCredential) => {
    if (option.role === "host") {
      return option.name ? `Continue as ${option.name} (host)` : "Continue as host";
    }
    return option.name ? `Continue as ${option.name}` : "Continue as your earlier guest identity";
  };

  return (
    <main
      className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 px-6 text-center"
      data-testid="choose-identity"
    >
      <div className="flex flex-col items-center gap-2">
        <Typography variant="h4" sx={{ fontWeight: "bold" }}>
          Join room
        </Typography>
        <Typography variant="body2" className="font-mono text-gray-500">
          {roomId}
        </Typography>
      </div>

      {notice && (
        <p className="max-w-sm rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {notice}
        </p>
      )}

      <div className="flex w-full max-w-sm flex-col gap-3">
        <p className="text-sm text-gray-500">You&apos;ve been in this room before in this browser.</p>
        {options.map((option) => (
          <Button
            key={option.token}
            variant="contained"
            size="large"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(option.token);
              try {
                await onContinue(option);
              } finally {
                setBusy(null);
              }
            }}
            sx={{ textTransform: "none" }}
          >
            {busy === option.token ? "Checking…" : label(option)}
          </Button>
        ))}

        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-gray-400">
          <span className="h-px flex-1 bg-gray-200" />
          or
          <span className="h-px flex-1 bg-gray-200" />
        </div>

        <Button
          variant="outlined"
          size="large"
          disabled={busy !== null}
          onClick={onJoinAsSomeoneElse}
          sx={{ textTransform: "none" }}
        >
          Join as someone else
        </Button>
        <p className="text-xs text-gray-500">The host will be asked to let you in.</p>
      </div>
    </main>
  );
};

export default ChooseIdentity;
