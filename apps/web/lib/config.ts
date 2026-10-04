/**
 * Runtime endpoints for the collaboration backend.
 *
 * Both values must be inlined at build time, so they are read from
 * `NEXT_PUBLIC_*` variables with localhost defaults for local development.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001";
