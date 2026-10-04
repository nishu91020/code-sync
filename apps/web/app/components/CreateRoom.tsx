'use client';
import { Button, TextField, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getStoredIdentity, saveIdentityName, suggestName } from "@/lib/identity";
import { parseRoomId, roomApi, saveRoomCredential } from "@/lib/roomAccess";

export const CreateRoom = () => {
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [roomInput, setRoomInput] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const router = useRouter();

  // Pre-fill with the name already used in this tab, or a friendly suggestion.
  useEffect(() => {
    setName(getStoredIdentity()?.name ?? suggestName());
  }, []);

  const createNewRoom = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Please enter a username");
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const { roomId, hostToken } = await roomApi.create(trimmed);
      // The creator is the host: this token is what lets them in and lets
      // them admit everyone else.
      saveRoomCredential(roomId, { token: hostToken, role: "host", name: trimmed });
      saveIdentityName(trimmed);
      router.push(`/room/${roomId}`);
    } catch (err) {
      console.error(err);
      setError("Failed to create room");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Opens someone else's room. The room page decides what happens next: people
   * who already have access go straight in, everyone else asks the host.
   */
  const joinRoom = async () => {
    const roomId = parseRoomId(roomInput);
    if (!roomId) {
      setJoinError("Paste a room link or ID");
      return;
    }

    setJoinError(null);
    setJoining(true);
    try {
      const room = await roomApi.describe(roomId);
      if (!room.exists) {
        setJoinError("No room with that link or ID");
        return;
      }
      if (!room.joinable) {
        setJoinError("That room has no host, so nobody can be let in");
        return;
      }
      // Carried over so the join screen is already filled in.
      if (name.trim()) saveIdentityName(name.trim());
      router.push(`/room/${roomId}`);
    } catch {
      setJoinError("Could not reach the server");
    } finally {
      setJoining(false);
    }
  };

  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <Typography variant="h4" sx={{ fontWeight: "bold" }}>
          CodeSync
        </Typography>
        <Typography variant="subtitle1" sx={{ maxWidth: 600 }}>
          Online Live Code Editor with seamless collaboration and real-time code sharing.
        </Typography>
      </div>

      <div className="flex w-full max-w-sm flex-col gap-4">
        <TextField
          label="Your username"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createNewRoom();
          }}
          error={Boolean(error)}
          helperText={error ?? "Collaborators will see this name on your cursor"}
          slotProps={{ htmlInput: { maxLength: 32 } }}
          fullWidth
          autoFocus
        />

        <Button
          variant="contained"
          onClick={createNewRoom}
          disabled={loading || !name.trim()}
          size="large"
        >
          {loading ? "Creating Room..." : "Create Room"}
        </Button>

        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-gray-400">
          <span className="h-px flex-1 bg-gray-200" />
          or join a room
          <span className="h-px flex-1 bg-gray-200" />
        </div>

        <div className="flex items-start gap-2">
          <TextField
            label="Room link or ID"
            value={roomInput}
            onChange={(e) => {
              setRoomInput(e.target.value);
              setJoinError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") joinRoom();
            }}
            error={Boolean(joinError)}
            helperText={joinError ?? "The host will be asked to let you in"}
            fullWidth
          />
          <Button
            variant="outlined"
            onClick={joinRoom}
            disabled={joining || !roomInput.trim()}
            size="large"
            sx={{ height: 56, flexShrink: 0 }}
          >
            {joining ? "Joining…" : "Join"}
          </Button>
        </div>
      </div>
    </main>
  );
};
