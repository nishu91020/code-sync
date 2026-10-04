"use client";

import { CircularProgress } from "@mui/material";

import type { ExecutionState } from "@/lib/useYSync";

function Section({ label, body, tone }: { label: string; body: string; tone: "out" | "err" }) {
  if (!body) return null;
  return (
    <div className="mb-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <pre
        className={`whitespace-pre-wrap break-words font-mono text-sm ${
          tone === "err" ? "text-red-400" : "text-gray-200"
        }`}
      >
        {body}
      </pre>
    </div>
  );
}

export const OutputPanel = ({ execution }: { execution: ExecutionState }) => {
  const { status, stdout, stderr, exitCode, startedBy, message } = execution;

  const hasOutput = Boolean(stdout || stderr);

  return (
    <div className="flex h-full flex-col border-t bg-gray-950 text-gray-200">
      <div className="flex items-center gap-3 border-b border-gray-800 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">Output</span>

        {status === "running" && (
          <span className="flex items-center gap-2 text-xs text-amber-400">
            <CircularProgress size={12} color="inherit" />
            {startedBy ? `${startedBy} is running the code…` : "Running…"}
          </span>
        )}

        {status === "done" && (
          <span
            className={`text-xs ${exitCode === 0 ? "text-green-400" : "text-red-400"}`}
          >
            {exitCode === 0 ? "✓ Finished" : `✗ Exited with code ${exitCode}`}
            {startedBy ? ` · run by ${startedBy}` : ""}
          </span>
        )}

        {status === "error" && <span className="text-xs text-red-400">✗ {message}</span>}
      </div>

      <div className="flex-1 overflow-auto px-4 py-3">
        {status === "idle" && (
          <p className="text-sm text-gray-500">
            Press <span className="font-semibold text-gray-300">Run</span> to execute the code.
            Everyone in the room sees the same output.
          </p>
        )}

        {status === "done" && !hasOutput && (
          <p className="text-sm text-gray-500">Program produced no output.</p>
        )}

        <Section label="stdout" body={stdout} tone="out" />
        <Section label="stderr" body={stderr} tone="err" />
      </div>
    </div>
  );
};

export default OutputPanel;
