"use client";

import { useCallback, useEffect, useState } from "react";
import { Editor, type OnMount } from "@monaco-editor/react";
import {
  Button,
  MenuItem,
  Select,
  Typography,
  Tooltip,
} from "@mui/material";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";

import { API_URL } from "@/lib/config";
import { LANGUAGES, THEMES, type Language } from "@/lib/languages";
import { useYSync } from "@/lib/useYSync";
import { useRuntimeStatus } from "@/lib/useRuntimeStatus";
import { useHostAccess } from "@/lib/useHostAccess";
import { ACCESS_CLOSE_CODES, type RoomRole } from "@/lib/roomAccess";
import PresenceBar from "./PresenceBar";
import OutputPanel from "./OutputPanel";
import StdinPanel from "./StdinPanel";
import ResizeHandle from "./ResizeHandle";
import RuntimeChip from "./RuntimeChip";
import { JoinRequests, PeopleMenu } from "./HostAccess";

/** A toolbar control stacked under its own caption, laid out beside its siblings. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500">{label}</span>
      {children}
    </div>
  );
}

type Props = {
  roomId: string;
  /** Host or admitted-member credential; every request for this room carries it. */
  token: string;
  role: RoomRole;
  /** Called with a 44xx code when the server refuses or ends our access. */
  onAccessLost: (code: number) => void;
};

const EditorComponent = ({ roomId, token, role, onAccessLost }: Props) => {
  const [theme, setTheme] = useState<string>("vs-dark");
  const [stdin, setStdin] = useState("");
  const [runError, setRunError] = useState<string | null>(null);

  const {
    isConnected,
    isSynced,
    accessError,
    peers,
    self,
    language,
    setLanguage,
    execution,
    createBinding,
    destroyBinding,
  } = useYSync(`room-${roomId}`, token);

  useEffect(() => {
    if (accessError !== null) onAccessLost(accessError);
  }, [accessError, onAccessLost]);

  const isHost = role === "host";
  const hostAccess = useHostAccess(roomId, token, isHost);

  useEffect(() => {
    return () => {
      destroyBinding();
    };
  }, [roomId, destroyBinding]);

  // The backend starts this language's container as soon as the room selects
  // it; this follows that container's state.
  const runtime = useRuntimeStatus(language);
  const runnerState = runtime.state;
  const imageBuilt =
    runnerState !== null && runnerState !== "missing" && runnerState !== "unavailable";

  const handleEditorMount: OnMount = (editor) => {
    createBinding(editor);
  };

  // Remembers how the panes were dragged, per browser.
  const mainLayout = useDefaultLayout({
    id: "codesync-main",
    panelIds: ["editor", "panels"],
    storage: typeof window === "undefined" ? undefined : window.localStorage,
  });
  const panelsLayout = useDefaultLayout({
    id: "codesync-panels",
    panelIds: ["stdin", "output"],
    storage: typeof window === "undefined" ? undefined : window.localStorage,
  });

  const isRunning = execution.status === "running";
  // A run during warm-up simply waits for the container, so only a missing
  // image or unreachable Docker disables Run.
  const canRun = runtime.executable && imageBuilt && isSynced && !isRunning;

  const { refresh: refreshRuntime } = runtime;
  const handleRun = useCallback(async () => {
    setRunError(null);
    try {
      // No `startedBy`: the server attributes the run to whoever the token
      // belongs to.
      const response = await fetch(`${API_URL}/api/room/${roomId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ language, stdin }),
      });

      if (response.status === 401 || response.status === 403) {
        onAccessLost(ACCESS_CLOSE_CODES.forbidden);
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setRunError(body?.error ?? `Run failed (HTTP ${response.status})`);
        // The runner's situation changed (image removed, Docker stopped…).
        refreshRuntime();
      }
    } catch {
      setRunError("Could not reach the server");
    }
  }, [roomId, token, language, stdin, refreshRuntime, onAccessLost]);

  const actionTooltip = !runtime.executable
    ? `${language} has no runtime and cannot be executed`
    : runnerState === "unavailable"
      ? "Docker isn't reachable from the backend"
      : runnerState === "missing"
        ? `The ${language} runner image isn't built`
        : !isSynced
          ? "Connecting…"
          : isRunning
            ? "A run is already in progress"
            : runnerState === "cold" || runnerState === "starting"
              ? `Starting the ${language} runner — a run now waits for it`
              : "Run the shared code";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-gray-200 bg-gray-100 px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Typography variant="h6" sx={{ fontWeight: "bold" }}>
            CodeSync
          </Typography>
          <div className="text-sm text-gray-500">
            Room: <span className="font-mono font-medium">{roomId}</span>
          </div>
          <div className={`text-sm ${isConnected ? "text-green-600" : "text-red-600"}`}>
            {!isConnected ? "○ Disconnected" : isSynced ? "● Connected" : "● Syncing…"}
          </div>
          <PresenceBar self={self} peers={peers} />
          {isHost && <PeopleMenu access={hostAccess} hostName={self.name} />}
        </div>

        <div className="flex flex-row flex-wrap items-end gap-3">
          <Field label="Language (shared)">
            <div className="flex items-center gap-2">
              <Select
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
                size="small"
                sx={{ minWidth: 150 }}
              >
                {LANGUAGES.map((lang) => (
                  <MenuItem key={lang} value={lang}>
                    {lang}
                  </MenuItem>
                ))}
              </Select>
              <RuntimeChip
                language={language}
                executable={runtime.executable}
                state={runnerState}
                message={runtime.message}
              />
            </div>
          </Field>

          <Field label="Theme">
            <Select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              size="small"
              sx={{ minWidth: 130 }}
            >
              {THEMES.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </Select>
          </Field>

          <Tooltip title={actionTooltip}>
            <span>
              <Button variant="contained" onClick={handleRun} disabled={!canRun}>
                {isRunning ? "Running…" : "▶ Run"}
              </Button>
            </span>
          </Tooltip>
        </div>
      </header>

      {isHost && <JoinRequests access={hostAccess} />}

      {runtime.executable && runnerState === "unavailable" && (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          Docker isn&apos;t reachable from the backend, so <strong>Run</strong> is disabled. Start
          Docker and this clears on its own.
          {runtime.message ? <span className="text-amber-700"> ({runtime.message})</span> : null}
        </div>
      )}

      {runtime.executable && runnerState === "missing" && (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          The <strong>{language}</strong> runner image isn&apos;t built yet. Run{" "}
          <code className="font-mono">npm run runners:build -- {language}</code> and it is picked
          up automatically.
        </div>
      )}

      {runError && (
        <div className="shrink-0 border-b border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {runError}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <Group orientation="vertical" id="codesync-main" {...mainLayout}>
          <Panel id="editor" defaultSize={62} minSize={15}>
            <Editor
              theme={theme}
              height="100%"
              width="100%"
              language={language}
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: true },
                fontSize: 15,
                automaticLayout: true,
                scrollBeyondLastLine: false,
              }}
            />
          </Panel>

          <ResizeHandle orientation="vertical" />

          <Panel id="panels" defaultSize={38} minSize={10}>
            <Group orientation="horizontal" id="codesync-panels" {...panelsLayout}>
              <Panel id="stdin" defaultSize={28} minSize={10}>
                <StdinPanel value={stdin} onChange={setStdin} disabled={isRunning} />
              </Panel>

              <ResizeHandle orientation="horizontal" />

              <Panel id="output" defaultSize={72} minSize={15}>
                <OutputPanel execution={execution} />
              </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
    </div>
  );
};

export default EditorComponent;
