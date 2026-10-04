"use client";

import { CircularProgress, Tooltip } from "@mui/material";

import type { RuntimeState } from "@/lib/useRuntimeStatus";

type Look = { label: string; tone: string; hint: string; spinner?: boolean };

function lookFor(language: string, state: RuntimeState | null, message: string | null): Look {
  switch (state) {
    case "ready":
      return { label: "● Ready", tone: "text-green-600", hint: `A ${language} runner is warm` };
    case "starting":
    case "cold":
      return {
        label: "Starting…",
        tone: "text-amber-600",
        hint: `Starting a ${language} runner container`,
        spinner: true,
      };
    case "missing":
      return {
        label: "Not built",
        tone: "text-amber-600",
        hint: `Run: npm run runners:build -- ${language}`,
      };
    case "error":
      return {
        label: "● Error",
        tone: "text-red-600",
        hint: message ?? `The ${language} runner failed to start`,
      };
    case "unavailable":
      return {
        label: "● No Docker",
        tone: "text-red-600",
        hint: message ?? "Docker isn't reachable from the backend",
      };
    default:
      return { label: "", tone: "", hint: "" };
  }
}

/** Shows whether the selected language's runner container is up. */
export const RuntimeChip = ({
  language,
  executable,
  state,
  message,
}: {
  language: string;
  executable: boolean;
  state: RuntimeState | null;
  message: string | null;
}) => {
  if (!executable) {
    return <span className="whitespace-nowrap text-xs text-gray-400">No runtime</span>;
  }

  const look = lookFor(language, state, message);
  if (!look.label) return null;

  return (
    <Tooltip title={look.hint}>
      <span
        className={`flex items-center gap-1 whitespace-nowrap text-xs font-medium ${look.tone}`}
        data-runtime-state={state ?? undefined}
      >
        {look.spinner ? <CircularProgress size={10} color="inherit" /> : null}
        {look.label}
      </span>
    </Tooltip>
  );
};

export default RuntimeChip;
