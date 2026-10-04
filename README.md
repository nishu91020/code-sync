# CodeSync

An online live code-sharing IDE. Multiple people open the same room and edit the
same document simultaneously, with real-time cursors and presence.

Collaboration is built on **Yjs** (a CRDT), so concurrent edits merge
deterministically without a central locking or operational-transform server.

---

## Architecture

> For the design decisions behind this structure — why a CRDT, why Postgres,
> why one container per run, and the tradeoffs each choice accepted — see
> **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

```
apps/web        Next.js 16 app (App Router) + Monaco editor
apps/backend    Express + ws server speaking the y-websocket protocol
packages/ui     Shared React components
packages/utils  Shared constants/helpers
prisma/         Database schema (Postgres)
```

The backend serves **HTTP and WebSocket traffic on a single port** (`3001` by
default):

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness probe plus room/connection counts |
| `POST /api/room` | Creates a room; the caller becomes its host. Returns `{ roomId, hostToken }` |
| `GET /api/room/:roomId` | Public: whether the room exists and can be joined. Nothing else |
| `GET /api/room/:roomId/me` | Who a token belongs to (`host` or `member`) |
| `POST /api/room/:roomId/join-requests` | A guest asks to join. Returns a request id and secret |
| `GET` / `DELETE /api/room/:roomId/join-requests/:id` | The guest polls or withdraws their request (request secret) |
| `GET /api/room/:roomId/access` | Host only: pending requests and admitted members |
| `POST /api/room/:roomId/join-requests/:id/admit` · `/deny` | Host only: decide a request |
| `DELETE /api/room/:roomId/members/:memberId` | Host only: revoke a member and disconnect them |
| `GET /api/languages` | Lists executable languages and the state of each one's runner container |
| `POST /api/room/:roomId/run` | Host or member: runs the room's code and shares the result |
| `ws://<host>:3001/room-<roomId>?token=…` | Collaboration socket; host or member token required |

### Collaboration protocol

The server implements the standard **y-websocket** wire protocol, so the browser
uses the stock `y-websocket` client and gets reconnection with exponential
backoff, offline edit buffering and cross-tab sync for free.

Messages are binary `lib0`-encoded frames:

| Type | Name | Meaning |
|---|---|---|
| `0` | sync | Yjs sync handshake and document updates |
| `1` | awareness | Presence: cursors, selections, user identity |
| `3` | query awareness | Request the current presence state |

Each room is one `Y.Doc` held in memory. Documents stay resident for 30 minutes
after the last client leaves so a page reload never loses content, then they are
evicted.

### Persistence

Room documents are snapshotted to Postgres as the binary output of
`Y.encodeStateAsUpdate`, stored on `DocState.update`.

Writes are **debounced** (`SAVE_DEBOUNCE_MS`, default 5s) so a burst of
keystrokes produces a single write, and a snapshot is also forced when the last
client leaves a room and on graceful shutdown. When a cold room is first opened,
the document is hydrated from Postgres *before* the sync handshake completes, so
collaborators never see an empty editor flash.

If `DATABASE_URL` is not set, the server falls back to in-memory storage and
logs that rooms will not survive a restart.

### Shared room state

Besides the document text, two `Y.Map`s are synchronised so the room behaves
consistently for everyone:

| Map | Keys | Purpose |
|---|---|---|
| `meta` | `language` | The editor language — changing it updates every collaborator |
| `execution` | `status`, `stdout`, `stderr`, `exitCode`, `startedBy`, `message` | The latest run, so everyone sees the same output |

Theme stays local, because it is a personal preference rather than a property of
the document.

### Room access

Rooms are private. Whoever creates a room is its **host**, and nobody else can
read, edit or run code in it until the host lets them in.

1. **Create:** `POST /api/room` returns the room id and a secret **host token**.
2. **Ask:** someone opening the link, or pasting the link or room ID into
   **Join a room** on the home page, sees *"This room is private"*, enters their
   name, and asks to join. They then wait, and nothing from the room is sent to
   them.
3. **Decide:** a modal pops up for the host: *"Someone wants to join: Ravi"*,
   with **Admit** / **Deny**. **Decide later** collapses it into a reminder
   bar, and the tab title shows *"🔔 Ravi wants to join"* while anyone is
   waiting. An admitted guest gets their own **member token** and enters the
   room.
4. **Remove:** the host's **People** menu lists everyone admitted. Removing
   someone revokes their token and disconnects them immediately.

**Each browser tab is its own participant.** The credential a tab is using
lives in `sessionStorage`, so a reload keeps you in. Every credential the
browser has been given is also remembered in `localStorage`. When the link is
opened in a new tab, those identities are *offered* rather than assumed:
**"Continue as Nishu (host)"** or **"Join as someone else"**. So the host can
always get back into their own room, while a second tab can still be a genuine
new guest who has to be admitted.

How it is enforced, all on the server:

- **Only real rooms exist.** The WebSocket only accepts `room-<uuid>` names of
  rooms created through `POST /api/room`. Anything else is refused before any
  document is loaded, and storage never creates a room as a side effect of
  saving.
- **Every entry point needs a credential.** The WebSocket (`?token=`), runs,
  and `/me` all require the host token or a member token. Access management is
  host-only. Runs are attributed to the name the server admitted, not one the
  client claims.
- **Tokens are 256-bit and stored only as SHA-256 hashes**, compared in
  constant time, so a database leak does not leak working credentials.
- **Join requests are short-lived and bounded.** They live in memory and are
  dropped 30 s after the guest stops waiting. A room can have at most 20
  waiting, and each client can make `JOIN_RATE_LIMIT` requests a minute.
- **Refusals use WebSocket close codes the app understands:** 4400 bad room
  name, 4401 no token, 4403 not admitted or removed, 4404 no such room. The
  client stops reconnecting and shows the reason.

Rooms created before access control existed have no host, so they cannot be
joined; the app says so. Anyone holding a member token, including someone it
was shared with, has that member's access until the host removes them.

There are no user accounts yet (see Roadmap phase 3).

### Code execution

`POST /api/room/:roomId/run` takes the source from the **server's own copy** of
the document — never from the request body — so collaborators always run exactly
what is on screen. The server writes `running`, then the result, into the
`execution` map, which broadcasts to the whole room.

#### Language runners

Every language has its own Docker image in `runners/<language>/`. Each is a thin
layer on an official image that adds an unprivileged `runner` user (uid 10001)
and a `run` script that compiles and executes `/workspace/main.<ext>`. Anything
a language needs is **baked in at build time**: the TypeScript loader, Go's
standard-library build cache, a restored .NET SDK, and a precompiled
`<bits/stdc++.h>` for C++. **Nothing is downloaded or installed at runtime.**

| Language | Base image | Notes |
|---|---|---|
| javascript | `node:22-alpine` | |
| typescript | `node:22-alpine` | `tsx` baked in |
| python | `python:3.12-alpine` | |
| java | `eclipse-temurin:21-jdk-alpine` | source-file launcher; any public class name works |
| cpp | `alpine:3.20` + `g++` | C++20, `-O2`, precompiled `<bits/stdc++.h>` |
| csharp | `mcr.microsoft.com/dotnet/sdk:10.0-alpine` | .NET 10 file-based app, pre-restored |
| php | `php:8.3-cli-alpine` | |
| ruby | `ruby:3.3-alpine` | |
| go | `golang:1.25-alpine` | standard-library build cache baked in |
| rust | `rust:1-alpine` | edition 2021, `-O` |

Build them once (about 3.5 GB in total, mostly .NET and Rust):

```bash
npm run runners:build              # every language
npm run runners:build -- python go # just some
```

A language whose image isn't built shows **Not built** in the UI together with
the exact command to build it. The backend notices a newly built image within a
few seconds, without a restart.

#### Container lifecycle

A container exists only while someone is using its language:

1. When a room **selects a language** (or opens with one already selected), the
   backend sees the change to the shared `meta.language` and starts one idle
   container for it. The toolbar chip shows *Starting…*, then *Ready*.
2. **Run** takes that warm container, uploads the source and stdin, executes
   it, and then **destroys the container**. A fresh replacement is warmed while
   the run executes. No container ever serves two runs, so nothing leaks between
   rooms or users.
3. When no open room has used the language for `RUNNER_IDLE_MS` (5 minutes by
   default), its warm container is removed.

`RUNNER_MAX_CONTAINERS` caps how many containers can exist at once. When the cap
is reached, a warm container for a language nobody is using (one only waiting
out its idle period) is removed to make room, so idle leftovers never block a
run. Leftover containers from a crashed backend are removed at startup, and
every container is removed on a clean shutdown.

#### Sandbox

Each container runs with no network, as uid 10001 with every capability dropped
and `no-new-privileges`. It has a memory limit set per language (256 MB–1 GB,
with no swap), `RUNNER_CPUS` CPUs, and process and file-size limits. `/tmp` is a
size-capped tmpfs. A run is killed when it exceeds `RUN_TIMEOUT_MS` (compilation
included) or floods output. For stronger isolation, set `RUNNER_RUNTIME=runsc`
to run containers under gVisor.

> The backend controls Docker, which is effectively root on the Docker host.
> That is fine for local development. In production, put the runners on a
> dedicated host, or use rootless Docker or gVisor.

#### Limits and failure modes

Runs are rate limited per room (`RUN_RATE_LIMIT` per `RUN_RATE_WINDOW_MS`), one
at a time, with output truncated. If Docker is unreachable, **Run** is disabled
and the UI says why; it recovers on its own once Docker is back.
`GET /api/languages` reports one of these states for every language:
`missing`, `cold`, `starting`, `ready`, `error`, or `unavailable`.

The editor, `stdin` and output are three draggable panes — `stdin` sits beside
the output so multi-line program input is comfortable, and the layout you drag
is remembered in `localStorage`.

---

## Getting started

### Prerequisites

- Node.js >= 26.4.0
- npm 10+
- Docker (Postgres/Redis, and the language runners for code execution)

### Install

```bash
npm install
```

### Configure

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local
```

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `PORT` | backend | `3001` | HTTP + WebSocket port |
| `CORS_ORIGIN` | backend | `http://localhost:3000` | Comma-separated allowed origins (`*` to allow all) |
| `DATABASE_URL` | backend | *(unset)* | Postgres connection string; without it rooms are in-memory only |
| `SAVE_DEBOUNCE_MS` | backend | `5000` | Delay before an edited room is snapshotted |
| `RUNNER_IDLE_MS` | backend | `300000` | Remove a language's warm container after this long unused |
| `RUNNER_MAX_CONTAINERS` | backend | `6` | Most runner containers alive at once |
| `RUNNER_CPUS` | backend | `2` | CPUs per runner container |
| `RUNNER_RUNTIME` | backend | *(unset)* | Alternative OCI runtime for runners, e.g. `runsc` (gVisor) |
| `RUNNER_DRIVER` | backend | `docker` | `none` disables code execution (used by tests) |
| `DOCKER_HOST` | backend | *(platform default)* | Docker engine to use; the named pipe on Windows by default |
| `RUN_TIMEOUT_MS` | backend | `15000` | Per-run wall-clock limit, compilation included |
| `RUN_RATE_LIMIT` | backend | `10` | Runs allowed per room per window |
| `RUN_RATE_WINDOW_MS` | backend | `60000` | Rate-limit window |
| `JOIN_RATE_LIMIT` | backend | `10` | Join requests allowed per client IP per minute |
| `NEXT_PUBLIC_API_URL` | web | `http://localhost:3001` | Backend HTTP base URL |
| `NEXT_PUBLIC_WS_URL` | web | `ws://localhost:3001` | Backend WebSocket base URL (use `wss://` in production) |

### Database

```bash
docker compose up -d postgres
npm run db:migrate      # applies prisma/migrations
npm run db:generate     # regenerates the Prisma client
```

Prisma 7 talks to Postgres through the `@prisma/adapter-pg` driver adapter
rather than a bundled query engine.

### Run

```bash
# Optional: Postgres + Redis
docker compose up -d

# One-off: build the language runner images (see "Language runners")
npm run runners:build

# Everything, via Turborepo
npm run dev

# ...or individually
npm run dev --workspace=backend   # http://localhost:3001
npm run dev --workspace=web       # http://localhost:3000
```

Open <http://localhost:3000>, enter a username, click **Create Room**, and share the
resulting `/room/<id>` URL. Others open that link, or paste it (or just the room
ID) into **Join a room** on the home page, and ask to join. A modal asks you to
admit or deny each of them. To try it alone, open the link in a second tab and
choose **Join as someone else**.

### Verify

```bash
npm run lint
npm run check-types
npm test --workspace=backend
```

The backend suite spins up a real server and drives it with three concurrent
Yjs clients, asserting document convergence, late-joiner sync and awareness
cleanup on disconnect. The access-control tests check that made-up room names
and missing or forged tokens are refused, that only the host can admit, deny or
remove, and that a removed member is disconnected and loses access everywhere.

Persistence tests are skipped unless a test database is provided. They spawn
the real server as a child process, write a document, restart the process and
assert that the content is restored from Postgres and the host token still works:

```bash
# PowerShell
$env:TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/mydb?schema=public"
npm test --workspace=backend
```

The other execution tests use an in-memory stand-in for Docker. The suite that
drives the **real** runner images is opt-in. It runs every language with
multi-line stdin and checks the sandbox: no network, unprivileged user, timeout
kill, output flood, memory and file-size limits, and no leftover containers.

```bash
# PowerShell; needs `npm run runners:build` first
$env:TEST_DOCKER="1"
npm test --workspace=backend
```

---

## Status

**Working**

- Real-time collaborative editing (Yjs CRDT + Monaco)
- Remote cursors, selections and a live participant list
- **User-chosen usernames** — picked when creating or joining a room, shown on
  cursors and in the participant list
- **Shared language selection** — changing it updates every collaborator
- **Code execution** in prebuilt per-language Docker images, with shared output,
  stdin, rate limiting and timeouts
- **On-demand runner containers** — started when a room selects a language,
  one fresh container per run, removed when idle
- **Resizable editor / stdin / output panes**, remembered between visits
- Room creation and shareable room URLs
- **Private rooms with host admission:** guests ask to join, the host admits or
  denies, and the host can remove people at any time
- Document persistence to Postgres — rooms survive a restart
- Automatic reconnection with offline edit buffering
- Origin-restricted CORS and WebSocket upgrades
- Single-port HTTP + WebSocket server
- Automated tests for convergence, restart persistence, access control, language sync and execution

**Not yet implemented**

- User accounts (sign-in) and finer roles such as read-only viewers
- Multi-file projects / file tree
- Horizontal scaling across multiple backend instances

---

## Roadmap

| Phase | Scope |
|---|---|
| ~~0~~ | ~~Binary frames, single port, env-driven config~~ ✅ |
| ~~1~~ | ~~Awareness: remote cursors, selections, presence~~ ✅ |
| ~~2~~ | ~~Persistence: `Room`/`DocState` models, debounced snapshots, hydrate cold rooms~~ ✅ |
| ~~5~~ | ~~Execution: sandboxed per-language runner containers, shared output panel, rate limiting~~ ✅ |
| 3 | Identity: Clerk accounts on top of today's host admission, `VIEWER`/`EDITOR` roles |
| 4 | Multi-file: one `Y.Text` per file, collaborative file tree in a `Y.Map`, tabs |
| 6 | Scale: Redis pub/sub fan-out across backend replicas |
| 7 | Hardening: Playwright E2E, CI, structured logging, rate limits |

### Phase 6 design notes

Without Redis fan-out, two users served by different backend replicas will
silently never see each other. Each instance should publish a room's updates on
`room:{id}` and relay received messages to its local sockets.
