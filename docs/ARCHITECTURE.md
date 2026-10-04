# CodeSync — Architecture

This document explains **how CodeSync is built and why**. The [README](../README.md)
describes what the system does and how to run it; this document covers the
structure, the design decisions behind it, the alternatives that were
considered, and the tradeoffs that were accepted.

- [1. Context and goals](#1-context-and-goals)
- [2. System overview](#2-system-overview)
- [3. Component architecture](#3-component-architecture)
- [4. Data model](#4-data-model)
- [5. Key flows](#5-key-flows)
- [6. Design decisions](#6-design-decisions)
- [7. Cross-cutting concerns](#7-cross-cutting-concerns)
- [8. Known limitations and technical debt](#8-known-limitations-and-technical-debt)
- [9. Evolution path](#9-evolution-path)

---

## 1. Context and goals

CodeSync is a browser-based collaborative IDE. Several people open the same
room URL, edit one document together with live cursors and presence, pick a
language, and run the code — seeing the same output.

### Functional goals

| Goal | Consequence for the architecture |
|---|---|
| Concurrent editing with no lost updates | A CRDT, not locking or server-side OT |
| Sub-100 ms local echo | Edits apply locally first and replicate asynchronously |
| Survive reloads, disconnects and backend restarts | Server-side document residency + durable snapshots |
| Everyone sees the same language and the same run output | Room state lives *in the document*, not in component state |
| Rooms are private by default | Server-enforced host admission on every entry point |
| Running untrusted code must not compromise the host | Per-run, per-language, network-less containers |

### Non-goals (today)

- User accounts and persistent identity (phase 3)
- Multi-file projects (phase 4)
- Horizontal scaling across backend replicas (phase 6)
- Running CodeSync as untrusted multi-tenant SaaS — the runner sandbox is
  hardened but the backend still holds a Docker socket (see [6.14](#614-the-backend-drives-docker-directly))

### Driving constraints

1. **Single developer, local-first development.** Everything must work on one
   laptop with `npm run dev`, including without Docker and without Postgres.
2. **No paid infrastructure.** Postgres and Docker, both self-hosted.
3. **Windows is a first-class dev environment.** This has shaped real decisions
   (see [6.17](#617-stdin-is-uploaded-as-a-file-not-streamed)).

---

## 2. System overview

```
┌──────────────────────────────── Browser ────────────────────────────────┐
│  Next.js 16 (App Router, client components)                             │
│                                                                         │
│   Monaco editor ──MonacoBinding──┐                                      │
│   PresenceBar  ──awareness───────┤                                      │
│   OutputPanel  ──Y.Map(execution)┼── Y.Doc ── y-websocket provider      │
│   RuntimeChip  ──Y.Map(meta)─────┘                │        │            │
│   HostAccess   ──REST (polling)───────────────┐   │        │            │
└───────────────────────────────────────────────┼───┼────────┼────────────┘
                                                │   │        │
                         HTTP (JSON, Bearer)    │   │        │  WebSocket
                                                │   │        │  (binary lib0 frames)
┌───────────────────────────────────────────────▼───▼────────▼────────────┐
│                      Backend — single Node process, one port 3001       │
│                                                                         │
│  Express 5 ── access control ── runner API ── /health                   │
│       │                │                │                               │
│       │          access.js        runner/pool.js ──► Docker Engine      │
│       │        (tokens, admission)      ▲                 │             │
│       │                │                │ demand          ▼             │
│       ▼                ▼          runner/demand.js   per-language       │
│  ws server ──► yjsWebsocket.js ────────┘              containers        │
│                 (Y.Doc registry, sync + awareness,                      │
│                  debounced snapshots, eviction)                         │
│                          │                                              │
│                     storage.js (adapter)                                │
└──────────────────────────┼──────────────────────────────────────────────┘
                           │ Prisma 7 + @prisma/adapter-pg
                    ┌──────▼───────┐
                    │  PostgreSQL  │  Room · RoomMember · DocState(bytea)
                    └──────────────┘
```

Everything is one deployable backend process plus a Next.js app. The only
external runtime dependencies are **PostgreSQL** (optional — falls back to
memory) and the **Docker Engine** (optional — code execution degrades
gracefully).

### Repository layout

```
apps/web               Next.js app: editor, presence, panes, join/admit UI
apps/backend           Express + ws server, access control, runner orchestration
  lib/yjsWebsocket.js  y-websocket protocol, Y.Doc registry, persistence hooks
  lib/storage.js       Storage adapters (Prisma / in-memory)
  lib/access.js        Tokens, host admission, close codes
  lib/rateLimit.js     Fixed-window limiter
  lib/runner/          languages · pool · dockerDriver · demand · errors
  test/                node:test suites (collaboration, access, persistence, execution)
packages/ui            Shared React components
packages/utils         Shared constants/helpers
packages/*-config      Shared ESLint / TypeScript configs
prisma/                Schema and migrations
runners/<language>/    One Dockerfile + `run` script per executable language
```

---

## 3. Component architecture

### 3.1 Frontend (`apps/web`)

Next.js is used as an **application shell, not a data layer**. There are no
server actions, no route handlers, and no server-side fetching of room data.
All room state arrives over the WebSocket, so the pages that matter are client
components.

| Module | Responsibility |
|---|---|
| `lib/useYSync.ts` | Owns the `Y.Doc`, the `WebsocketProvider` and the `MonacoBinding`. The single source of room truth for React |
| `lib/roomAccess.ts` | REST client + credential storage (sessionStorage per tab, localStorage as a remembered set) |
| `lib/useHostAccess.ts` | Host-only polling of pending join requests and members |
| `lib/useRuntimeStatus.ts` | Polls `/api/languages` for runner container state |
| `lib/identity.ts` | Per-tab display name and cursor colour |
| `app/room/[roomId]/` | Layout: editor / stdin / output panes, presence bar, admission modals |

`useYSync` deliberately exposes a **flat, serialisable state object**
(`isConnected`, `isSynced`, `peers`, `language`, `execution`, …). Components
never touch Yjs types directly, so the CRDT stays an implementation detail of
one module.

### 3.2 Collaboration server (`lib/yjsWebsocket.js`)

A `Map<string, WSSharedDoc>` of live rooms. `WSSharedDoc` extends `Y.Doc` and
adds:

- **Connection registry** — `Map<WebSocket, Set<awarenessClientId>>`, so a
  dropped socket can clear exactly the presence entries it owned.
- **Broadcast on update** — every document and awareness update is re-encoded
  as a `lib0` frame and fanned out to the room's sockets.
- **Hydration promise** (`whenLoaded`) — the sync handshake is held until the
  snapshot has loaded, so a late joiner never sees an empty editor flash.
- **Dirty tracking + debounced flush** — `SAVE_DEBOUNCE_MS` (5 s default).
  Updates tagged with the `PERSISTENCE_ORIGIN` symbol do not re-dirty the doc.
- **Eviction** — a room with zero connections is snapshotted immediately, then
  evicted after `EMPTY_ROOM_TTL` (30 min).
- **Liveness** — a 30 s ping/pong loop reaps half-open sockets. All timers use
  `unref()` so they never hold the event loop open.

It also emits generic `active` / `inactive` room events on an `EventEmitter`.
This is the seam that lets the runner subsystem react to rooms **without this
module knowing that runners exist**.

### 3.3 Access control (`lib/access.js`)

A factory (`createAccessControl({ storage, now, staleMs, … })`) rather than a
module of free functions, so tests can inject a fake clock and fake storage.

- Durable facts (host token hash, members) go to the storage adapter.
- Ephemeral facts (pending join requests) stay in a `Map` with a lazy sweep.
- Every failure is an `AccessError` carrying **both** an HTTP status and a
  WebSocket close code, because the same check guards both transports.

### 3.4 Runner subsystem (`lib/runner/`)

```
index.js       public API: runCode(), getRunnerPool(), limits, truncation
pool.js        warm-container lifecycle, capacity, image cache
dockerDriver.js the only module that knows about Docker
demand.js      maps "rooms using language X" → pool demand
languages.js   per-language source filename, memory and PID limits
```

The pool is driven by **demand**, not by requests: when a room becomes active
or its `meta.language` changes, `demand.js` calls `addDemand` / `removeDemand`,
and the pool warms or retires containers accordingly. A run therefore usually
finds a container already running.

`dockerDriver` is swappable (`setRunnerDriver`), which is what lets the
execution tests run with no Docker at all.

---

## 4. Data model

```prisma
Room        id, slug(unique), name, language, hostName, hostTokenHash,
            createdAt, lastActiveAt            @@index([lastActiveAt])
RoomMember  id, roomId→Room(cascade), name, tokenHash(unique), admittedAt
DocState    id, roomId→Room(unique, cascade), update Bytes, version, updatedAt
User        id, name, email(unique), image, …   -- reserved for phase 3, unused
```

Design points:

- **`slug` is the public identity.** A random UUID in the URL and in the Yjs
  document name (`room-<slug>`). `id` is an internal cuid. Enumerating rooms
  from the URL space is infeasible, and the internal key can change without
  breaking links.
- **`DocState.update` is one binary blob**, the output of
  `Y.encodeStateAsUpdate(doc)` — a merged CRDT state, not a text file and not
  an update log. See [6.7](#67-documents-are-stored-as-a-single-merged-crdt-snapshot).
- **Only token *hashes* are stored.** The plaintext token exists in the
  response body once and in the browser thereafter.
- **`version` is a monotonically incremented write counter**, useful for
  debugging and a hook for future optimistic concurrency. It is not currently
  enforced — a single writer per room makes that unnecessary today.
- **Cascades** mean deleting a room removes its members and snapshot in one
  statement.
- **`Room.language` is denormalised and currently unused** by the running
  system; the authoritative language lives in the document's `meta` map. It is
  kept for future room listings that must not hydrate a `Y.Doc` to show a
  language badge.

### In-document state (not in the database)

| Yjs type | Key | Why it lives in the CRDT |
|---|---|---|
| `Y.Text` | `monaco` | The document itself |
| `Y.Map` | `meta.language` | Must converge for everyone, and changes constantly |
| `Y.Map` | `execution.{status,stdout,stderr,exitCode,startedBy,finishedAt,message}` | Run output must reach every collaborator, including late joiners, with no extra channel |
| awareness | `user.{name,color}`, cursor/selection | Ephemeral by definition; never persisted |

Theme stays in `localStorage` — it is a property of the *person*, not the room.

---

## 5. Key flows

### 5.1 Create → join → admit

```
Host                 Backend                        Guest
 │ POST /api/room       │                             │
 │◄──{roomId,hostToken}─┤ Room row + empty DocState    │
 │                      │                             │
 │                      │◄── GET /api/room/:id ────────┤  exists? joinable?
 │                      │◄── POST /join-requests ──────┤  {name,color}
 │                      │──► {requestId,requestSecret}─┤
 │ GET /access (2 s)    │                             │ GET /join-requests/:id (poll)
 │◄──pending:[Ravi]─────┤                             │        status: pending
 │ POST …/admit ───────►│ member row + member token   │
 │                      │──────────────────────────►  │ status: admitted + token
 │                      │◄── ws://…/room-<id>?token ──┤
```

Why **polling** rather than SSE/WebSocket push for admission: the waiting guest
has no credential, so they cannot hold a room socket; opening a second
push channel purely for a transient handshake would add a connection lifecycle
to maintain for a flow that lasts seconds. Two independent 2 s polls are
cheap and trivially correct. Requests are swept 30 s after the guest stops
polling, which doubles as an "the guest gave up" signal.

### 5.2 Editing

```
keystroke → Monaco model → MonacoBinding → Y.Text → provider → ws frame (type 0)
                                                          │
backend: readSyncMessage → apply to server Y.Doc → broadcast to other conns
                                             └→ markDirty → debounce 5 s → Postgres
```

The server is a **full participant**, not a relay: it holds and applies the
document. That costs memory but buys three things that a dumb relay cannot
give — correct state-vector-based sync for late joiners, a server-side source
of truth for code execution, and snapshots without a designated client.

### 5.3 Running code

```
POST /api/room/:id/run  (Bearer host|member token)
  ├─ authenticate → principal.name   (the server's name, not the client's)
  ├─ isRunnable(language)?           → 400
  ├─ rate limit per room             → 429 + Retry-After
  ├─ execution.status === 'running'? → 409   (one run per room)
  ├─ source := server's Y.Text       ← never the request body
  ├─ execution ← {status:'running', startedBy, …}   → broadcast to room
  ├─ pool.acquire(language)  → warm container, replacement warming starts
  ├─ putArchive(main.<ext>, input.txt) → exec /usr/local/bin/run
  ├─ collect stdout/stderr, enforce timeout + flood kill
  ├─ pool.release(handle)    → container destroyed; another warmed
  └─ execution ← {status:'done', stdout, stderr, exitCode} → broadcast
```

Taking the source from the **server's** copy is a correctness decision as much
as a security one: with the request body, whoever clicks Run would execute
their own possibly-stale buffer while everyone else watches output that does
not match the editor in front of them.

### 5.4 Container lifecycle

```
room selects "go"  ──► addDemand(go)  ──► start warm container        [cold→starting→ready]
run                ──► acquire()      ──► take warm, warm replacement
                       execute        ──► destroy used container
language changed / everyone leaves ──► removeDemand(go)
no demand for RUNNER_IDLE_MS       ──► destroy warm container         [→cold]
at RUNNER_MAX_CONTAINERS           ──► evict a demand-0 warm container to make room
backend crash                      ──► removeOrphans() at next startup (owner-labelled)
```

---

## 6. Design decisions

Each decision records the alternatives considered and what was given up.

### 6.1 CRDT (Yjs) instead of Operational Transformation

**Decision.** Concurrency is resolved by Yjs's YATA CRDT, client-side and
server-side, using the same library.

**Alternatives.** (a) OT with a central transform server, à la ShareDB or
Google Wave. (b) Last-write-wins on whole-document saves. (c) Locking — one
editor at a time.

**Why.** OT requires a *correct* transform function plus a server that
serialises and rewrites every operation; its correctness burden is notoriously
high and it hard-couples the system to a single authoritative server. A CRDT
merges deterministically with no central arbiter, which also makes offline
editing and reconnection fall out for free rather than needing a resync
protocol. LWW loses work outright; locking destroys the product.

**Tradeoffs accepted.**
- **Metadata overhead.** Yjs keeps per-character item structures; a document's
  encoded state is larger than its text, and grows with edit history until
  garbage collection reclaims deleted items (`new Y.Doc({ gc: true })`).
- **Opaque storage.** The snapshot is a binary blob; you cannot `SELECT` the
  code out of Postgres. Reading it requires decoding through Yjs
  ([6.7](#67-documents-are-stored-as-a-single-merged-crdt-snapshot)).
- **No server veto.** Because merges are deterministic and local-first, the
  server cannot reject an edit on content grounds. Authorisation is therefore
  at the *connection* boundary, not per operation — which is exactly why
  removing a member must forcibly close their socket
  ([6.11](#611-revocation-closes-live-sockets)).
- **No built-in intent preservation** for structured edits; fine for text.

### 6.2 The y-websocket wire protocol, reimplemented in-process

**Decision.** The backend speaks the standard y-websocket binary protocol
(message types `0` sync, `1` awareness, `3` query-awareness) but implements it
inside the Express app rather than running `@y/websocket-server` as a separate
service.

**Alternatives.** (a) Run the upstream `y-websocket` server standalone.
(b) Invent a JSON protocol. (c) A hosted service (Liveblocks, PartyKit, Yjs's
y-sweet).

**Why.** Speaking the standard protocol means the browser uses the *stock*
`y-websocket` client and inherits exponential-backoff reconnection, offline
buffering, cross-tab sync via BroadcastChannel, and awareness — none of which
is worth reimplementing. Hosting it in-process is what makes the rest of the
product possible: authentication at the upgrade, server-side source for runs,
and lifecycle events that drive the runner pool. The upstream standalone
server offers no hook for any of those.

**Tradeoffs accepted.**
- **We own protocol compatibility.** A breaking change upstream is our problem;
  the code carries an explicit "must stay in sync with the client" note.
- **~250 lines of protocol code to maintain**, versus `npm i` of a server.
- **Collaboration and HTTP share an event loop.** A pathological run of
  document decoding can add latency to API responses. Acceptable at the
  current scale; the subsystems split cleanly along `yjsWebsocket.js` if not.
- JSON was rejected outright: it would roughly triple update size and lose
  client compatibility for no benefit.

### 6.3 One port for HTTP and WebSocket

**Decision.** `http.createServer(app)` plus a `WebSocketServer({ noServer: true })`
on the `upgrade` event.

**Why.** One port to configure, one TLS certificate, one origin for CORS, and
no second deployment target. Critically, the manual `upgrade` handler is the
only place where the room token can be checked *before* a document is touched.

**Tradeoff.** Long-lived sockets and request/response traffic cannot be scaled
or rate-limited independently, and a backend restart drops every editor
session. Both are revisited at phase 6.

### 6.4 Refusals are delivered as WebSocket close codes

**Decision.** A rejected connection is **accepted and then closed** with a
4400/4401/4403/4404 code, instead of failing the HTTP upgrade.

**Why.** A browser does not expose the status of a failed upgrade to
JavaScript — the app only sees "it didn't work" and the provider retries
forever. A close code *does* reach the client, so the UI can say "the host
removed you" and stop reconnecting (`provider.shouldConnect = false`).

**Tradeoff.** A handshake is completed for a request that is known to be
invalid, which is marginally more work for the server and slightly unusual.
Genuinely malformed origins are still rejected at the socket level.

### 6.5 Room-wide UI state lives in the CRDT

**Decision.** Selected language and the latest run result are `Y.Map`s inside
the room document.

**Alternatives.** (a) Separate REST endpoints + polling. (b) A second
WebSocket channel / custom message types. (c) Client-local state.

**Why.** It is replication the system already has. Synchronisation, conflict
resolution, late-joiner catch-up, persistence and reconnect buffering all come
for free, and the server can participate by writing to the same map (that is
how run output reaches every client — the backend writes `execution`, Yjs
broadcasts it). No new endpoint, no new socket, no fan-out code.

**Tradeoffs accepted.**
- Run output is **persisted** with the document and counts toward its size.
  Output is truncated to `MAX_OUTPUT_CHARS` (20 k), which caps this.
- The *last* run's result is the only history; it is overwritten in place.
- CRDT map semantics are last-writer-wins per key, so two simultaneous language
  changes converge to one — acceptable, and in fact the desired behaviour.
- Theme deliberately stays out, as per-user preference.

### 6.6 PostgreSQL as the system of record

**Decision.** Postgres, via Prisma 7 with the `@prisma/adapter-pg` driver
adapter.

**Alternatives considered.**

| Option | Why not |
|---|---|
| **Redis only** | Durability is a tuning exercise (RDB/AOF), and room/member data is genuinely relational. Redis *is* in the stack — reserved for phase 6 fan-out, where its actual strength lies |
| **MongoDB** | The data is relational (room→members→snapshot, cascading deletes, uniqueness on `slug` and `tokenHash`). A document store would mean enforcing those invariants in application code |
| **SQLite** | Fine for one process; blocks the multi-replica roadmap and complicates containerised deployment |
| **S3/object storage for snapshots** | Appealing for large blobs, but adds a second consistency domain for the sake of ~kilobyte objects |
| **Yjs-native (y-leveldb, y-redis)** | Solves document storage only. Rooms, hosts and members still need a database, and running two stores doubles the operational surface |

**Why Postgres.** Strong relational integrity, `bytea` handles the CRDT
snapshot natively, battle-tested, free, and it is the one store that can hold
*all* durable state.

**Why Prisma.** Typed client, first-class migrations (`prisma/migrations/`), and
a schema that doubles as documentation. The driver-adapter mode avoids shipping
a platform-specific query-engine binary — one fewer thing to break in Docker or
on Windows.

**Tradeoffs accepted.**
- An ORM between the app and a workload that is really "fetch one blob, write
  one blob". Mitigated by the storage adapter boundary: replacing Prisma with
  raw `pg` means rewriting one file.
- Prisma's migration workflow prefers a shadow database in development.
- `$connect` is lazy under driver adapters, so `createStorage` issues
  `SELECT 1` to find out at startup whether the database is genuinely usable —
  otherwise failures would surface only on the first save.

### 6.7 Documents are stored as a single merged CRDT snapshot

**Decision.** `DocState.update` holds `Y.encodeStateAsUpdate(doc)` — the whole
merged state, overwritten on each flush.

**Alternatives.** (a) Append-only update log, compacted periodically (the
`y-leveldb` model). (b) Store plain text. (c) Store both text and CRDT state.

**Why.** Reading is one row with no merge step on the hot path (room hydration
blocks the sync handshake, so it must be fast). Writing is one upsert, with no
compaction job and no risk of an unbounded log. For single-document rooms of
realistic size this is strictly simpler.

**Tradeoffs accepted.**
- **Write amplification.** Every flush rewrites the entire document. The
  debounce (5 s) plus a typical room size of kilobytes makes this a non-issue
  at current scale; for very large documents an update log would win.
- **The blob is not queryable or human-readable.** Storing plain text instead
  would discard all CRDT history and break reconnecting clients mid-edit, so
  text-only was rejected; storing both invites the two copies to disagree.
- **No version history** — snapshots overwrite. Yjs supports `Y.snapshot` for
  time travel, which this schema could later accommodate in a side table.

### 6.8 Storage is an adapter interface, with an in-memory fallback

**Decision.** A six-method duck-typed contract (`createRoom`, `load`, `save`,
`getAccess`, `addMember`, `removeMember`, `close`) with Prisma and in-memory
implementations; the server picks one at startup and **always starts**, even if
`DATABASE_URL` is unset or the database is unreachable.

**Why.** Contributors can clone and run with zero infrastructure. The tests use
the memory adapter and run in milliseconds with no database. And the escape
hatch from Prisma stays cheap.

**Tradeoff — accepted deliberately, and the sharpest one here.** Falling back
on a *connection failure* means a production misconfiguration can degrade to
silent data loss instead of crashing loudly. It is logged (`⚠️  Falling back to
in-memory persistence`). A production deployment should run with a strict mode
that refuses to start without the database it was configured for.

**Invariant.** `save()` **never creates a room** — it `update`s and returns
`false` on `P2025`. Only `createRoom()` creates. This is what guarantees an
arbitrary WebSocket document name cannot become a persisted room as a side
effect of someone typing.

### 6.9 Rooms stay resident in memory for 30 minutes after the last client leaves

**Decision.** `EMPTY_ROOM_TTL = 30 min`, with an immediate snapshot the moment
the room empties, and a re-check after the flush in case someone rejoined.

**Why.** A page reload or a tunnel change empties a room for a few seconds.
Evicting immediately would mean reloading and re-decoding the CRDT on every
refresh, and a brief window where the room appears empty.

**Tradeoff.** Idle memory. Bounded in practice by room count and document size;
there is currently **no global memory cap or LRU** across rooms, which is a
known gap ([§8](#8-known-limitations-and-technical-debt)).

### 6.10 Capability tokens instead of user accounts

**Decision.** Creating a room mints a 256-bit host token; admission mints a
per-member token. Only SHA-256 hashes are stored, compared with
`timingSafeEqual`. There is no sign-in.

**Alternatives.** (a) Clerk/Auth.js accounts up front. (b) A shared room
password. (c) Unlisted-URL-is-the-secret, with no admission at all.

**Why.** Accounts are a product decision with real surface area (provider,
sessions, profile, account recovery) that would have delayed the thing the
product is actually about. Capability tokens give per-participant revocation
and server-enforced authorisation *without* any of it, and they are the right
primitive to keep underneath accounts later: phase 3 layers Clerk identity on
top of today's admission rather than replacing it.

**Tradeoffs accepted.**
- **Tokens are bearer credentials.** Anyone a member forwards their token to
  has that member's access until the host removes them. The README says so
  explicitly.
- **No identity continuity.** Clear browser storage and you are a stranger
  again; the host cannot see that "Ravi" today is the same Ravi as yesterday.
- **No roles.** Host versus member only — read-only viewers need phase 3.
- Hashing is plain SHA-256, not a password KDF. That is correct *here*: the
  input is 256 bits of CSPRNG output, not a guessable secret, so a slow KDF
  would buy nothing and cost latency on every request.

### 6.11 Revocation closes live sockets

**Decision.** `DELETE /members/:id` deletes the row **and** calls
`closeConnections(docName, conn => conn.principal?.memberId === id, 4403)`.

**Why.** Authorisation happens at connect time; an already-open socket would
otherwise keep receiving updates forever. The principal is stashed on the
socket at upgrade precisely so this lookup is possible.

**Tradeoff.** Connection-scoped auth is coarse. It is the right granularity for
a CRDT, where per-operation authorisation is not meaningful ([6.1](#61-crdt-yjs-instead-of-operational-transformation)).

### 6.12 Join requests are in-memory and ephemeral

**Decision.** Pending requests live in a `Map`, are swept 30 s after the guest
stops polling, keep a decided result for 120 s so the guest can collect their
token, and are capped at 20 pending per room plus a per-IP rate limit.

**Why.** A join request is only meaningful while a human is staring at a
spinner. Persisting it would create rows nobody will ever read and a cleanup
job to delete them.

**Tradeoffs.** A backend restart drops pending requests (guests simply ask
again), and the design assumes a single instance — with replicas, a guest could
poll an instance that has never heard of their request. Phase 6 moves this to
Redis alongside the pub/sub fan-out.

### 6.13 Per-tab credentials in `sessionStorage`, remembered set in `localStorage`

**Decision.** Two storage tiers. The credential a tab is *using* is in
`sessionStorage`; every credential the browser has ever been granted for that
room is also recorded in `localStorage` (newest first, capped at 5) and merely
*offered* — "Continue as Nishu (host)" / "Join as someone else".

**Why.** `localStorage` alone made a second tab silently become the host,
skipping both the name prompt and the admission flow — a real bug this design
fixes. `sessionStorage` alone would lock a host out of their own room the
moment they closed the tab, with no recovery path. The two-tier scheme makes
each tab a genuine participant while keeping re-entry possible.

**Tradeoffs.** More storage logic (including a one-time migration of the legacy
single-credential key), and tokens sit in browser storage where XSS could read
them — an accepted risk for a bearer-token design, bounded by host revocation.

### 6.14 The backend drives Docker directly

**Decision.** The backend talks to the Docker Engine API via **dockerode** and
creates, execs into, and destroys containers itself.

**Alternatives.** (a) Shell out to the `docker` CLI. (b) A job queue plus a
separate worker service. (c) Firecracker/microVMs. (d) WASM sandboxes
(Pyodide, QuickJS). (e) A third-party execution API (Judge0, Piston).

**Why dockerode.** Structured API access to the things the CLI makes awkward or
impossible to do safely: `putArchive` for uploading source without string
quoting, multiplexed exec streams, label filters, and precise `HostConfig`
limits — with no shell-injection surface and no CLI parsing.

**Why not the alternatives.** WASM cannot run a JVM, .NET and rustc. A queue
and workers is the right production answer but adds a broker, a worker
deployment and a result channel before the feature exists at all. Firecracker
is Linux-only and heavy for a dev laptop. A third-party API would mean shipping
users' code off the machine.

**Tradeoff — the most significant risk in the system.** The Docker socket is
effectively root on the host. The *guest* code is well isolated (no network,
uid 10001, all capabilities dropped, `no-new-privileges`, memory/PID/fsize
caps, tmpfs `/tmp`, fresh container per run, optional gVisor via
`RUNNER_RUNTIME=runsc`) — but a compromise of the **backend process** is a
compromise of the host. This is documented in the README as a production
caveat: run runners on a dedicated host, or use rootless Docker/gVisor.

### 6.15 One container per run, warmed in advance

**Decision.** Containers are warmed on demand and destroyed after exactly one
run; the replacement is started *while* the run executes.

**Alternatives.** (a) Start a container per run (cold). (b) Reuse a long-lived
container across runs. (c) Keep a fixed pool per language.

**Why.** Cold-starting a .NET or Rust container on every click is seconds of
latency. Reusing one is unacceptable: state leaks between rooms and users —
files in `/workspace`, background processes, memory pressure from a previous
run. Warm-then-discard gets near-zero start latency *and* a guaranteed clean
environment. A *fixed* pool would keep idle containers for languages nobody
uses, which the demand model avoids.

**Tradeoffs.**
- Idle containers consume memory while a room has a language selected. Bounded
  by `RUNNER_MAX_CONTAINERS` (6) and reclaimed after `RUNNER_IDLE_MS` (5 min).
- Capacity pressure needs a tiebreak, so `#hasRoom()` evicts a warm container
  whose demand has already dropped to zero rather than failing a real run.
- Destruction is fire-and-forget (`release()` is not awaited) so teardown never
  delays the user's output; the live counter is decremented up front so the
  freed capacity is immediately usable.
- `removeOrphans()` at startup cleans up after a crash, scoped by an
  `owner` label (`hostname:port`) so two backends — or the test suite — on one
  Docker host never delete each other's containers.

### 6.16 Container demand is derived from the CRDT, not from an API call

**Decision.** `demand.js` subscribes to room `active`/`inactive` events and
observes each room's `meta` map; it never exposes an endpoint.

**Why.** The language a room is using is *already* replicated state. Deriving
demand from it means there is no second source of truth to drift, and no "the
client forgot to tell the server it switched language" bug class. The
`EventEmitter` seam keeps `yjsWebsocket.js` ignorant of runners, so
collaboration can be tested with no Docker and runners tested with no sockets.

**Tradeoff.** Indirection — reading "why did a container start?" means
following an event and a Yjs observer rather than a request handler. The
module is documented accordingly. Non-runnable selections (markup, data
formats) resolve to `null` and warm nothing.

### 6.17 stdin is uploaded as a file, not streamed

**Decision.** Source and stdin are packed into an in-memory tar and uploaded
with `putArchive`; the image's `run` script redirects `< /workspace/input.txt`.

**Why.** Half-closing an attached stdin stream is unreliable over Windows named
pipes, and a program blocking forever on EOF-that-never-arrives burns the whole
timeout and produces a baffling failure. A file always has an EOF.

**Tradeoffs.** No interactive stdin — a program cannot prompt and react, which
rules out REPL-style use. Input must be fully known before the run starts. For
"run this snippet against this input", that is the correct model.

### 6.18 Everything a language needs is baked into its image

**Decision.** Each runner image is an official base plus an unprivileged
`runner` user (uid 10001) and a `run` script. The TypeScript loader, Go's
standard-library build cache, a restored .NET SDK and a precompiled
`<bits/stdc++.h>` are all built in. Containers run with `NetworkMode: none`.

**Why.** Network isolation is the single most valuable sandbox property, and it
is only achievable if nothing is fetched at runtime. It also makes execution
times deterministic and immune to registry outages.

**Tradeoffs.** ~3.5 GB of images (mostly .NET and Rust) and a one-off build
step; no third-party libraries in user code; adding a language means authoring
a Dockerfile rather than adding a config line. The UI surfaces an unbuilt
image as **Not built**, with the exact command — and the pool re-checks images
every few seconds, so a newly built image is picked up without a restart.

### 6.19 Turborepo monorepo

**Decision.** npm workspaces + Turborepo, with shared `eslint-config`,
`typescript-config`, `ui` and `utils` packages.

**Why.** Frontend and backend share concepts that must not drift — the language
list, the WebSocket close codes, the shape of execution state. One repo means
one atomic commit changes the protocol on both sides, and Turborepo gives
task caching and one `npm run dev`.

**Tradeoffs.** More configuration than two repos; independent deployment takes
deliberate setup. In practice the sharing is currently **under-used**:
`packages/utils` already exports `roomDocName` and the `MESSAGE_*` constants,
but both sides redefine them locally — see [§8](#8-known-limitations-and-technical-debt).

### 6.20 Node's built-in test runner, driving a real server

**Decision.** `node --test` over `test/**/*.test.mjs`. No Jest, no Vitest, no
mocking framework. Tests boot the actual Express + ws server, connect **real**
Yjs clients, and assert convergence. Persistence tests spawn the server as a
child process, kill it and restart it. Docker tests are opt-in via `TEST_DOCKER=1`.

**Why.** Zero test-tooling dependencies and no transform step for an ESM
codebase. More importantly, the bugs that matter here — late-joiner sync,
awareness cleanup on disconnect, hydration before handshake, token refusal,
restart durability — are *integration* bugs. Unit tests with mocked sockets
would pass while the system failed.

**Tradeoffs.** Slower than unit tests, and sparser assertion/mocking ergonomics.
Seams are therefore designed for substitution rather than mocking:
`setStorage()`, `setRunnerDriver()`, and injectable `now`/`staleMs` in
`createAccessControl`. Opt-in Docker tests mean the real sandbox assertions
(no network, unprivileged user, timeout kill, flood kill, memory and fsize
limits, no leftover containers) are not exercised on every run.

### 6.21 In-process fixed-window rate limiting

**Decision.** A ~40-line fixed-window limiter in memory: per room for runs, per
IP for join requests, with `Retry-After` on 429.

**Why.** No Redis dependency for a single-instance deployment, and it covers
the two abuse vectors that actually exist (run flooding, join spam).

**Tradeoffs.** Fixed windows allow a 2× burst at a window boundary; limits are
per instance, so they multiply with replicas; and the map is swept lazily
(only past 1000 entries). The module's own comment names the fix: move it to
Redis alongside phase 6.

---

## 7. Cross-cutting concerns

### 7.1 Security posture

| Layer | Control |
|---|---|
| Transport | `helmet()` security headers; origin-allowlisted CORS; the same allowlist checked on WebSocket upgrade |
| Room identity | Random UUID slugs; only `room-<uuid>` document names accepted — anything else is refused before a doc is created |
| AuthN | 256-bit tokens, SHA-256 hashed at rest, `timingSafeEqual` comparison |
| AuthZ | Every entry point (WS, `/run`, `/me`, access management) requires a token; host-only routes check role; run attribution uses the *server's* name for the principal |
| Input | Names trimmed, control characters stripped, 32-char cap; colours regex-validated; 10 MB WebSocket payload cap; 128 KB source cap |
| Abuse | Per-room run limits, per-IP join limits, max 20 pending requests per room, one concurrent run per room |
| Execution | No network, uid 10001, `CapDrop: ALL`, `no-new-privileges`, memory == memory+swap, `PidsLimit`, `nofile`/`fsize` ulimits, tmpfs `/tmp`, wall-clock timeout, output flood kill, container destroyed after one run |
| Residual risk | Bearer tokens are forwardable; the backend holds a Docker socket ([6.14](#614-the-backend-drives-docker-directly)) |

### 7.2 Failure handling and degradation

The system is built to **degrade rather than fail**:

| Failure | Behaviour |
|---|---|
| No `DATABASE_URL` | In-memory storage; logged; rooms do not survive restart |
| Database unreachable at boot | Falls back to memory with a warning ([6.8](#68-storage-is-an-adapter-interface-with-an-in-memory-fallback) — also the system's sharpest tradeoff) |
| A snapshot write fails | `isDirty` is restored so the next flush retries; the error is logged, editing continues |
| Docker unreachable | Run is disabled with an explanation; `/api/languages` reports `unavailable`; recovers automatically |
| Runner image not built | `missing` state plus the exact build command |
| Container fails to start | Image cache invalidated and re-checked; the slot records the error, surfaced as `error` |
| Client disconnects | `y-websocket` reconnects with backoff and buffers offline edits; awareness entries for that socket are cleared |
| Access revoked | 4403 close; the client stops reconnecting and explains why |
| Socket goes half-open | 30 s ping/pong reaps it |
| Backend crash | Orphaned containers removed at next startup; rooms rehydrate from the last snapshot |
| `SIGINT`/`SIGTERM` | `flushAll()` → `storage.close()` → `runnerPool.shutdown()` before exit |

### 7.3 Performance characteristics

- **Local echo is immediate** — Monaco applies the edit, replication follows.
- **Updates are binary and incremental**; only the delta crosses the wire.
- **Hydration blocks the handshake** (not the connection), which is why
  snapshot reads are a single indexed row fetch.
- **Writes are debounced** 5 s, forced on empty and on shutdown — a burst of
  typing is one `UPDATE`.
- **Runs are usually warm**, because the replacement container is started
  concurrently with the current execution.
- **Output is bounded** at 20 k characters, with a 4 MB flood kill, so a
  runaway `while(true) print()` cannot grow the document or exhaust memory.

### 7.4 Observability

`morgan('tiny')` request logs, emoji-prefixed lifecycle logs, and `/health`
returning room and connection counts. This is **deliberately minimal and
acknowledged as insufficient for production** — structured logging and metrics
are phase 7.

---

## 8. Known limitations and technical debt

| Area | Issue | Impact |
|---|---|---|
| **Scaling** | Rooms live in one process's memory. Two users on different replicas would silently never see each other | Hard blocker on horizontal scaling. Phase 6 |
| **Persistence fallback** | A database outage degrades to memory rather than failing loudly | Possible silent data loss in production ([6.8](#68-storage-is-an-adapter-interface-with-an-in-memory-fallback)) |
| **Memory bounds** | No global cap or LRU across resident rooms | Many concurrent rooms could exhaust heap |
| **Shared constants duplicated** | `packages/utils` already exports `roomDocName` and `MESSAGE_*`, yet `lib/access.js`, `lib/yjsWebsocket.js` and `web/lib/roomAccess.ts` each redefine them. Close codes and language lists are likewise duplicated across `access.js`/`roomAccess.ts` and `runner/languages.js`/`web/lib/languages.ts` | Drift risk the monorepo and the shared package were meant to prevent |
| **Dependencies in the wrong workspace** | `@mui/material` (8 components) and `@monaco-editor/react` (`EditorComponent.tsx`) are imported by `apps/web` but declared only in the **root** `package.json`, along with their peers `@emotion/*` and `monaco-editor` | The web app resolves them by npm hoisting, not by declaration — it would break if built or deployed standalone |
| **Unused dependencies** | `react-router-dom`, `prism` and `@fontsource/roboto` (root), `clerk-nextjs` (web) are declared and never imported | Install bloat and misleading signal; should be pruned |
| **Two UI systems** | MUI components and Tailwind 4 / `@base-ui` / `class-variance-authority` coexist in `apps/web` | Inconsistent styling story and duplicated bundle weight; one should win |
| **`Room.language` / `User`** | Written-but-unread and entirely unused respectively | Harmless, but should be labelled as forward-looking in review |
| **Observability** | No structured logs, metrics or tracing | Hard to diagnose production issues. Phase 7 |
| **Testing** | No E2E coverage of the browser; sandbox tests are opt-in | UI regressions are caught by hand. Phase 7 |
| **Rate limiting** | Per-instance, fixed-window | 2× boundary bursts; multiplies with replicas |
| **Single document per room** | One `Y.Text` named `monaco` | No multi-file projects. Phase 4 |

---

## 9. Evolution path

The architecture is shaped so that each roadmap phase touches a bounded
surface.

**Phase 3 — Identity.** Clerk sits *above* the existing admission flow: a
signed-in user still becomes a host or an admitted member, but the token is
bound to an account rather than a browser. The `User` model already exists; a
`role` column on `RoomMember` plus a check in `requireRoomAccess` adds
`VIEWER`/`EDITOR`. No change to the collaboration protocol.

**Phase 4 — Multi-file.** One `Y.Text` per file and a file tree in a `Y.Map`,
inside the *same* document — so persistence, access control and sync are
unchanged. `getRoomSource()` gains a file argument; the runner contract already
takes an explicit source string.

**Phase 6 — Scale.** The decisive change. Each instance publishes a room's
updates on `room:{id}` in Redis and relays received messages to its local
sockets; CRDT semantics make out-of-order, at-least-once delivery safe, which
is exactly why Yjs was chosen in [6.1](#61-crdt-yjs-instead-of-operational-transformation). Two other things must move with it:
join requests ([6.12](#612-join-requests-are-in-memory-and-ephemeral)) and rate-limit counters ([6.21](#621-in-process-fixed-window-rate-limiting)).
Snapshot writes need a per-room leader or an optimistic check on
`DocState.version` so replicas do not clobber each other. Runners should move
behind a queue to a dedicated host at the same time ([6.14](#614-the-backend-drives-docker-directly)).

**Phase 7 — Hardening.** Playwright E2E, CI, structured logging and metrics.
Candidates for the first dashboards: resident rooms, connections per room,
snapshot write latency, run queue depth, warm-hit rate, container start
failures.
