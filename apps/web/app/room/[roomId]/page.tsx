'use client';
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";

import JoinRoom from "../../components/JoinRoom";
import ChooseIdentity from "../../components/ChooseIdentity";
import { saveIdentityName } from "@/lib/identity";
import {
  ACCESS_CLOSE_CODES,
  ApiError,
  forgetRoomCredential,
  getRememberedCredentials,
  getTabCredential,
  roomApi,
  saveRoomCredential,
  type RoomCredential,
} from "@/lib/roomAccess";

// Monaco and y-monaco touch `window` at module scope, so the editor must never
// be evaluated during server rendering.
const EditorComponent = dynamic(() => import("../../components/EditorComponent"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center">Loading editor...</div>
  ),
});

type Props = {
  params: Promise<{ roomId: string }>;
};

type Gate =
  | { kind: "checking" }
  | { kind: "ready"; credential: RoomCredential }
  | { kind: "choose"; options: RoomCredential[]; notice: string | null }
  | { kind: "join"; notice: string | null }
  | { kind: "not-found" }
  | { kind: "locked" }
  | { kind: "error"; message: string };

type Verification =
  | { kind: "ok"; credential: RoomCredential }
  | { kind: "revoked"; status: number }
  | { kind: "not-found" }
  | { kind: "error" };

const REMOVED_NOTICE = "Your access to this room was removed by the host.";

/** Asks the server whether a credential still grants access, and as whom. */
async function verify(roomId: string, credential: RoomCredential): Promise<Verification> {
  try {
    const me = await roomApi.me(roomId, credential.token);
    return { kind: "ok", credential: { token: credential.token, role: me.role, name: me.name } };
  } catch (err) {
    if (!(err instanceof ApiError)) return { kind: "error" };
    if (err.status === 404) return { kind: "not-found" };
    return { kind: "revoked", status: err.status };
  }
}

function Message({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children}
      <Link href="/" className="mt-2 text-blue-600 underline">
        Create a new room
      </Link>
    </main>
  );
}

/**
 * Lets someone into the editor only with a credential the server accepts.
 * Everyone else goes through the host's admission flow.
 *
 * Each tab is its own participant. A tab that already holds a credential
 * (e.g. after a reload) goes straight in; a new tab in a browser that has been
 * here before is *offered* those identities rather than silently given them,
 * so opening the link in another tab can be a genuinely new guest.
 */
export default function RoomPage({ params }: Props) {
  const [roomId, setRoomId] = useState<string>("");
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const activeToken = useRef<string | null>(null);

  useEffect(() => {
    // Unwrap params (required in Next.js 15+)
    params.then((resolvedParams) => {
      setRoomId(resolvedParams.roomId);
    });
  }, [params]);

  const enter = useCallback(
    (credential: RoomCredential) => {
      saveRoomCredential(roomId, credential);
      // Show the name the server knows, so presence matches what the host admitted.
      if (credential.name) saveIdentityName(credential.name);
      activeToken.current = credential.token;
      setGate({ kind: "ready", credential });
    },
    [roomId],
  );

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    (async () => {
      setGate({ kind: "checking" });
      let notice: string | null = null;

      const current = getTabCredential(roomId);
      if (current) {
        const result = await verify(roomId, current);
        if (cancelled) return;
        if (result.kind === "ok") {
          enter(result.credential);
          return;
        }
        if (result.kind === "not-found") {
          setGate({ kind: "not-found" });
          return;
        }
        if (result.kind === "error") {
          setGate({ kind: "error", message: "Could not reach the server." });
          return;
        }
        forgetRoomCredential(roomId, current.token);
        if (result.status === 403) notice = REMOVED_NOTICE;
      }

      try {
        const room = await roomApi.describe(roomId);
        if (cancelled) return;
        if (!room.exists) {
          setGate({ kind: "not-found" });
          return;
        }
        if (!room.joinable) {
          setGate({ kind: "locked" });
          return;
        }
        const remembered = getRememberedCredentials(roomId);
        setGate(
          remembered.length > 0
            ? { kind: "choose", options: remembered, notice }
            : { kind: "join", notice },
        );
      } catch {
        if (!cancelled) setGate({ kind: "error", message: "Could not reach the server." });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId, attempt, enter]);

  /** A remembered identity was picked in a new tab. */
  const handleContinue = useCallback(
    async (credential: RoomCredential) => {
      const result = await verify(roomId, credential);
      if (result.kind === "ok") {
        enter(result.credential);
        return;
      }
      if (result.kind === "not-found") {
        setGate({ kind: "not-found" });
        return;
      }
      if (result.kind === "error") {
        setGate({ kind: "error", message: "Could not reach the server." });
        return;
      }
      forgetRoomCredential(roomId, credential.token);
      const options = getRememberedCredentials(roomId);
      setGate(
        options.length > 0
          ? { kind: "choose", options, notice: REMOVED_NOTICE }
          : { kind: "join", notice: REMOVED_NOTICE },
      );
    },
    [roomId, enter],
  );

  const handleAdmitted = useCallback(
    (credential: RoomCredential) => {
      enter(credential);
    },
    [enter],
  );

  // The server ended our access mid-session (e.g. the host removed us).
  const handleAccessLost = useCallback(
    (code: number) => {
      if (code === ACCESS_CLOSE_CODES.notFound) {
        setGate({ kind: "not-found" });
        return;
      }
      if (activeToken.current) forgetRoomCredential(roomId, activeToken.current);
      activeToken.current = null;
      setGate({
        kind: "join",
        notice:
          code === ACCESS_CLOSE_CODES.forbidden
            ? "The host removed you from this room."
            : "You need the host's permission to join this room.",
      });
    },
    [roomId],
  );

  if (!roomId || gate.kind === "checking") {
    return <div className="flex h-dvh items-center justify-center">Loading room...</div>;
  }

  if (gate.kind === "not-found") {
    return (
      <Message title="Room not found">
        <p className="text-gray-500">Check the link, or ask the host for a new one.</p>
      </Message>
    );
  }

  if (gate.kind === "locked") {
    return (
      <Message title="This room can't be joined">
        <p className="max-w-md text-gray-500">
          It was created before rooms had hosts, so there is nobody who can let you in.
        </p>
      </Message>
    );
  }

  if (gate.kind === "error") {
    return (
      <Message title="Something went wrong">
        <p className="text-gray-500">{gate.message}</p>
        <button className="text-blue-600 underline" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </Message>
    );
  }

  if (gate.kind === "choose") {
    return (
      <ChooseIdentity
        roomId={roomId}
        options={gate.options}
        notice={gate.notice}
        onContinue={handleContinue}
        onJoinAsSomeoneElse={() => setGate({ kind: "join", notice: null })}
      />
    );
  }

  if (gate.kind === "join") {
    return <JoinRoom roomId={roomId} notice={gate.notice} onAdmitted={handleAdmitted} />;
  }

  return (
    <div className="h-dvh w-full overflow-hidden">
      <EditorComponent
        roomId={roomId}
        token={gate.credential.token}
        role={gate.credential.role}
        onAccessLost={handleAccessLost}
      />
    </div>
  );
}
