"use client";

import { useCallback, useEffect, useState } from "react";

import { API_URL } from "./config";

/**
 * - `missing`     the language's runner image has not been built
 * - `cold`        built, but no container is running for it
 * - `starting`    a container is being started for it
 * - `ready`       a warm container is waiting for the next run
 * - `error`       the last attempt to start a container failed
 * - `unavailable` the backend cannot reach Docker at all
 */
export type RuntimeState = "missing" | "cold" | "starting" | "ready" | "error" | "unavailable";

type LanguagesResponse = {
  runnable: string[];
  available: string[];
  dockerReachable: boolean;
  message?: string;
  runtimes: Record<string, { state: RuntimeState; message?: string }>;
};

export type RuntimeStatus = {
  /** Whether the language has a runner at all; markup/data formats do not. */
  executable: boolean;
  /** `null` until the first answer, and for languages that are not executable. */
  state: RuntimeState | null;
  message: string | null;
  refresh: () => void;
};

// How often to re-check while waiting for something to change. A missing image,
// a failed start or unreachable Docker is polled too, so building the image or
// starting Docker is noticed without a reload (and lets the backend retry).
const POLL_MS: Partial<Record<RuntimeState, number>> = {
  starting: 1500,
  cold: 3000,
  missing: 5000,
  error: 5000,
  unavailable: 5000,
};

/**
 * Tracks the runner container for `language`. The backend starts that
 * container when the room selects the language, so this is re-checked on every
 * change and polled until the container is up.
 */
export function useRuntimeStatus(language: string): RuntimeStatus {
  const [data, setData] = useState<LanguagesResponse | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/languages`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData((await response.json()) as LanguagesResponse);
    } catch {
      // Keep the last known state; the run itself reports an unreachable server.
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [language, refresh]);

  const executable = data?.runnable.includes(language) ?? false;
  const runtime = executable ? data?.runtimes[language] : undefined;
  const state = runtime?.state ?? null;
  const pollMs = state ? POLL_MS[state] : undefined;

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(refresh, pollMs);
    return () => clearInterval(id);
  }, [pollMs, refresh]);

  const message =
    runtime?.message ?? (state === "unavailable" ? (data?.message ?? null) : null);

  return { executable, state, message, refresh };
}
