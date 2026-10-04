"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import { WebsocketProvider } from "y-websocket";

import { WS_URL } from "./config";
import { getIdentity, type YUser } from "./identity";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "./languages";
import { applyRemoteCursorStyles, clearRemoteCursorStyles } from "./remoteCursorStyles";
import { isAccessCloseCode } from "./roomAccess";

export type Peer = YUser & { clientId: number };

export type ExecutionStatus = "idle" | "running" | "done" | "error";

export type ExecutionState = {
  status: ExecutionStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  language: string | null;
  startedBy: string | null;
  finishedAt: number | null;
  message: string | null;
};

export const EMPTY_EXECUTION: ExecutionState = {
  status: "idle",
  stdout: "",
  stderr: "",
  exitCode: null,
  language: null,
  startedBy: null,
  finishedAt: null,
  message: null,
};

export type YSyncState = {
  /** True once the websocket is open. */
  isConnected: boolean;
  /** True once the initial document handshake has completed. */
  isSynced: boolean;
  /**
   * Set when the server refused or ended our access (a 44xx close code, e.g.
   * the host removed us). The provider stops reconnecting when this happens.
   */
  accessError: number | null;
  /** Everyone else currently present in the room. */
  peers: Peer[];
  /** This tab's own identity. */
  self: YUser;
  /** Editor language, shared by everyone in the room. */
  language: Language;
  setLanguage: (language: Language) => void;
  /** Result of the most recent run, shared by everyone in the room. */
  execution: ExecutionState;
  /** Current editor contents, for submitting to the runner. */
  getSource: () => string;
  createBinding: (editor: unknown) => void;
  destroyBinding: () => void;
};

const TEXT_KEY = "monaco";
const META_KEY = "meta";
const EXECUTION_KEY = "execution";

function readUser(state: unknown): YUser | null {
  if (!state || typeof state !== "object") return null;
  const user = (state as { user?: unknown }).user;
  if (!user || typeof user !== "object") return null;
  const { name, color } = user as { name?: unknown; color?: unknown };
  if (typeof name !== "string" || typeof color !== "string") return null;
  return { name, color };
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readExecution(map: Y.Map<unknown>): ExecutionState {
  const status = str(map.get("status"), "idle") as ExecutionStatus;
  const exitCode = map.get("exitCode");
  const finishedAt = map.get("finishedAt");

  return {
    status: ["idle", "running", "done", "error"].includes(status) ? status : "idle",
    stdout: str(map.get("stdout")),
    stderr: str(map.get("stderr")),
    exitCode: typeof exitCode === "number" ? exitCode : null,
    language: typeof map.get("language") === "string" ? (map.get("language") as string) : null,
    startedBy: typeof map.get("startedBy") === "string" ? (map.get("startedBy") as string) : null,
    finishedAt: typeof finishedAt === "number" ? finishedAt : null,
    message: typeof map.get("message") === "string" ? (map.get("message") as string) : null,
  };
}

/**
 * Connects a Yjs document to the collaboration server and binds it to a Monaco
 * editor, including awareness (remote cursors, selections and presence).
 *
 * `token` is the room credential (host or admitted member). The server refuses
 * the connection without one.
 */
export function useYSync(room: string, token: string): YSyncState {
  const self = useMemo(() => getIdentity(), []);

  const [isConnected, setIsConnected] = useState(false);
  const [isSynced, setIsSynced] = useState(false);
  const [accessError, setAccessError] = useState<number | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [language, setLanguageState] = useState<Language>(DEFAULT_LANGUAGE);
  const [execution, setExecution] = useState<ExecutionState>(EMPTY_EXECUTION);

  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  /**
   * Binds the editor to the shared text type. Monaco's `onMount` and this
   * hook's connection effect race with one another, so this is invoked from
   * both sides and only proceeds once every dependency is available.
   */
  const bind = useCallback(() => {
    if (bindingRef.current) return;

    const editor = editorRef.current;
    const doc = docRef.current;
    const provider = providerRef.current;
    if (!editor || !doc || !provider) return;

    const model = editor.getModel?.();
    if (!model) return;

    bindingRef.current = new MonacoBinding(
      doc.getText(TEXT_KEY),
      model,
      new Set([editor]),
      provider.awareness,
    );
  }, []);

  useEffect(() => {
    const doc = new Y.Doc();
    docRef.current = doc;

    const provider = new WebsocketProvider(WS_URL, room, doc, { params: { token } });
    providerRef.current = provider;

    provider.awareness.setLocalStateField("user", self);

    const handleStatus = ({ status }: { status: string }) => {
      setIsConnected(status === "connected");
    };

    const handleSync = (synced: boolean) => {
      setIsSynced(synced);
    };

    // A 44xx close means "you may not be here". Retrying cannot help, so stop
    // the provider's automatic reconnection and let the page take over.
    const handleClose = (event: CloseEvent | null) => {
      if (event && isAccessCloseCode(event.code)) {
        provider.shouldConnect = false;
        setAccessError(event.code);
      }
    };

    const handleAwarenessChange = () => {
      const states = provider.awareness.getStates();
      const localId = provider.awareness.clientID;

      const styleMap = new Map<number, YUser>();
      const nextPeers: Peer[] = [];

      states.forEach((state, clientId) => {
        const user = readUser(state);
        if (!user) return;
        styleMap.set(clientId, user);
        if (clientId !== localId) {
          nextPeers.push({ clientId, ...user });
        }
      });

      applyRemoteCursorStyles(styleMap);
      setPeers(nextPeers.sort((a, b) => a.clientId - b.clientId));
    };

    provider.on("status", handleStatus);
    provider.on("sync", handleSync);
    provider.on("connection-close", handleClose);
    provider.awareness.on("change", handleAwarenessChange);
    handleAwarenessChange();

    // Room-wide settings live in the document so every collaborator sees the
    // same language and the same run output.
    const meta = doc.getMap(META_KEY);
    const executionMap = doc.getMap(EXECUTION_KEY);

    const handleMetaChange = () => {
      const shared = meta.get("language");
      setLanguageState(isLanguage(shared) ? shared : DEFAULT_LANGUAGE);
    };

    const handleExecutionChange = () => {
      setExecution(readExecution(executionMap));
    };

    meta.observe(handleMetaChange);
    executionMap.observe(handleExecutionChange);
    handleMetaChange();
    handleExecutionChange();

    bind();

    return () => {
      provider.off("status", handleStatus);
      provider.off("sync", handleSync);
      provider.off("connection-close", handleClose);
      provider.awareness.off("change", handleAwarenessChange);
      meta.unobserve(handleMetaChange);
      executionMap.unobserve(handleExecutionChange);

      bindingRef.current?.destroy();
      bindingRef.current = null;

      clearRemoteCursorStyles();

      // Clears our awareness state for everyone else before tearing down.
      provider.destroy();
      providerRef.current = null;

      doc.destroy();
      docRef.current = null;

      setIsConnected(false);
      setIsSynced(false);
      setAccessError(null);
      setPeers([]);
      setLanguageState(DEFAULT_LANGUAGE);
      setExecution(EMPTY_EXECUTION);
    };
  }, [room, token, self, bind]);

  const createBinding = useCallback(
    (editor: unknown) => {
      editorRef.current = editor;
      bind();
    },
    [bind],
  );

  const destroyBinding = useCallback(() => {
    bindingRef.current?.destroy();
    bindingRef.current = null;
  }, []);

  const setLanguage = useCallback((next: Language) => {
    // Writing to the shared map notifies every collaborator, including us.
    docRef.current?.getMap(META_KEY).set("language", next);
  }, []);

  const getSource = useCallback(() => {
    return docRef.current?.getText(TEXT_KEY).toString() ?? "";
  }, []);

  return {
    isConnected,
    isSynced,
    accessError,
    peers,
    self,
    language,
    setLanguage,
    execution,
    getSource,
    createBinding,
    destroyBinding,
  };
}
