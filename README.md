# Reliable recording chunking pipeline

Course / hackathon assignment: build and reason about a **reliable client-side chunking pipeline** for audio recordings. The goal is **no silent data loss**: chunks are buffered on the client, uploaded to object storage, and only then acknowledged in PostgreSQL. The client can **reconcile** when the database and bucket disagree (for example after a failed upload or bucket repair).

This repository is a **Turborepo monorepo**: a Next.js web app, a Hono API on Bun, shared UI and database packages, and Docker Compose for local Postgres + MinIO (S3-compatible storage).

---

## Table of contents

1. [Architecture](#architecture)
2. [Design decisions](#design-decisions)
3. [Prerequisites](#prerequisites)
4. [Instructor checklist: run locally from zero](#instructor-checklist-run-locally-from-zero)
5. [Environment variables](#environment-variables)
6. [Scripts reference](#scripts-reference)
7. [HTTP API (for grading and load tests)](#http-api-for-grading-and-load-tests)
8. [Load testing notes](#load-testing-notes)
9. [Project structure](#project-structure)
10. [Troubleshooting](#troubleshooting)

---

## Architecture

End-to-end flow:

```mermaid
flowchart LR
  subgraph browser [Browser]
    Mic[Microphone]
    Chunk[Chunk WAV 16kHz]
    OPFS[(OPFS)]
    UI[Next.js UI]
    Mic --> Chunk
    Chunk --> OPFS
    OPFS --> UI
  end
  subgraph api [API Bun + Hono]
    Upload[POST /api/chunks/upload]
    Audit[GET .../audit]
  end
  subgraph infra [Docker]
    S3[(MinIO)]
    PG[(PostgreSQL)]
  end
  UI -->|multipart| Upload
  Upload --> S3
  Upload --> PG
  UI --> Audit
  Audit --> PG
  Audit --> S3
```

- **Client (`apps/web`)**  
  - Captures audio, resamples to 16 kHz, encodes **WAV** chunks on an interval (default 5 s) in `useRecorder`.  
  - Persists each chunk to the **Origin Private File System (OPFS)** before uploading, so a tab crash or offline period does not drop bytes that were already captured.  
  - Uploads via **multipart `FormData`** to the API, then tracks per-chunk status (local, uploading, acked, failed, repaired).  
  - **Reconciliation** calls `GET /api/chunks/recordings/:id/audit`, compares DB acks with bucket presence (`HeadObject`), and re-uploads from OPFS when the server says the object is missing.

- **API (`apps/server`)**  
  - **Hono** app; dev server uses **Bun** with hot reload.  
  - Validates form fields, uploads bytes to **S3** (AWS SDK; works with MinIO using path-style URLs), then inserts a row into **`chunk_acks`** (Drizzle).  
  - Uses **`onConflictDoNothing`** on `(recording_id, sequence_no)` so retries and duplicate uploads are safe; returns the existing row when the insert is skipped.

- **Data (`packages/db`)**  
  - **Drizzle ORM** + **PostgreSQL** schema for acknowledgments (`chunk_acks`).  
  - **Drizzle Kit** reads `apps/server/.env` for `DATABASE_URL` when pushing schema.

- **Infrastructure (`packages/db/docker-compose.yml`)**  
  - **Postgres** on host port **5434** (mapped to 5432 in the container).  
  - **MinIO** on **9000** (S3 API) and **9001** (console). A one-shot **`minio-init`** service creates bucket `recordings`.

- **Config (`packages/env`)**  
  - **T3-style env** with Zod: `server` schema for the API, `web` schema for `NEXT_PUBLIC_SERVER_URL`.

Optional: **DeepSeek** (or compatible OpenAI-style API) for **text-only** transcript cleanup (`POST /api/transcription/cleanup`). No audio is sent to the model.

---

## Design decisions

| Decision | Rationale |
|----------|-----------|
| **OPFS before network** | Chunks are durable on disk in the browser origin before any upload attempt, aligning with “never lose captured audio silently.” |
| **Multipart upload, not JSON** | WAV blobs are binary; `FormData` avoids base64 overhead and matches what browsers emit naturally. |
| **S3-compatible storage + Postgres acks** | Matches real-world “object store + metadata DB” patterns. Ack rows are the source of “what the system believes was stored,” while the bucket holds bytes. |
| **`/audit` with HEAD per object** | Lets the client detect **DB vs bucket drift** (e.g. bucket wipe, partial failure) without trusting the DB alone. |
| **Idempotent ack insert** | Unique index on `(recording_id, sequence_no)` plus `onConflictDoNothing` makes retries safe. |
| **Monorepo + Turborepo** | Single install, shared `@my-better-t-app/*` packages, one `turbo dev` for web + API. |
| **Next.js on 3001, API on 3000** | Avoids clashing with other local apps; CORS is configured from `CORS_ORIGIN` to match the web origin. |
| **Bun for the server in dev** | Fast iteration; `package.json` uses `bun run --hot`. Production builds may use compiled output per `apps/server` scripts. |

---

## Prerequisites

Install on the machine used to run the stack:

| Tool | Role |
|------|------|
| **Node.js** | 20.x or newer recommended (for npm and Next.js). |
| **npm** | 10.x (lockfile uses `packageManager`: npm@10.9.4). |
| **Bun** | Required for `apps/server` dev script (`bun run --hot`). [Install Bun](https://bun.sh). |
| **Docker Desktop** (or Docker Engine + Compose) | Runs Postgres and MinIO from `packages/db/docker-compose.yml`. |

---

## Instructor checklist: run locally from zero

Follow these steps in order. Paths are relative to the **repository root**.

### 1. Clone and install dependencies

```bash
git clone <repository-url>
cd <repository-directory>
npm install
```

### 2. Start Postgres and MinIO

From the repo root:

```bash
npm run db:start
```

This runs `docker compose up -d` in `packages/db` (see `packages/db/docker-compose.yml`).

Verify containers are healthy:

```bash
docker ps
```

You should see containers such as `my-better-t-app-postgres` and `my-better-t-app-minio`.

- **Postgres**: `localhost:5434` → database `my-better-t-app`, user `postgres`, password `password`.  
- **MinIO S3 API**: `http://localhost:9000`  
- **MinIO console**: `http://localhost:9001` (login `minioadmin` / `minioadmin`)  
- **Bucket**: `recordings` (created by `minio-init`)

### 3. Create `apps/server/.env`

Create the file `apps/server/.env` (it is gitignored). Use the values below for a standard Docker setup; adjust if you changed Compose ports or credentials.

```env
DATABASE_URL=postgresql://postgres:password@localhost:5434/my-better-t-app
CORS_ORIGIN=http://localhost:3001

S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=recordings
S3_FORCE_PATH_STYLE=true

NODE_ENV=development
```

Optional (transcript cleanup feature):

```env
DEEPSEEK_API_KEY=your-key
# DEEPSEEK_BASE_URL=https://api.deepseek.com
# DEEPSEEK_MODEL=deepseek-chat
```

### 4. Create `apps/web/.env.local`

```env
NEXT_PUBLIC_SERVER_URL=http://localhost:3000
```

This must be a valid URL (the shared env package validates it). No trailing slash required.

### 5. Apply the database schema

```bash
npm run db:push
```

This uses Drizzle Kit with `DATABASE_URL` from `apps/server/.env`.

### 6. Start the web app and API together

```bash
npm run dev
```

- **Web**: [http://localhost:3001](http://localhost:3001) — home page runs read-only API health checks.  
- **Recorder UI**: [http://localhost:3001/recorder](http://localhost:3001/recorder) — full recording, OPFS, upload, and reconcile flow (requires microphone permission).  
- **API**: [http://localhost:3000](http://localhost:3000) — root should respond with `OK`.

### 7. Quick verification

1. Open `http://localhost:3001` and confirm the three API checks are **OK** (or fix `NEXT_PUBLIC_SERVER_URL` / server env).  
2. Open `http://localhost:3001/recorder`, grant microphone access, record briefly, and confirm chunks move to **acked** (or **already existed** on retry).  
3. In MinIO console, browse bucket `recordings` — objects under `recordings/<recordingId>/` should appear as `.wav` keys.

### 8. Stop infrastructure when finished

```bash
npm run db:stop
```

To remove containers and named volumes (wipes local DB and MinIO data):

```bash
npm run db:down
```

---

## Environment variables

### Server (`apps/server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string. |
| `CORS_ORIGIN` | Yes | Browser origin allowed by CORS (e.g. `http://localhost:3001`). |
| `S3_ENDPOINT` | Yes | S3 API endpoint (MinIO: `http://localhost:9000`). |
| `S3_REGION` | Yes | Region string (MinIO often uses `us-east-1`). |
| `S3_ACCESS_KEY` | Yes | S3 access key. |
| `S3_SECRET_KEY` | Yes | S3 secret key. |
| `S3_BUCKET` | Yes | Bucket name (Compose init uses `recordings`). |
| `S3_FORCE_PATH_STYLE` | No | Default `true` — required for MinIO-style endpoints. |
| `NODE_ENV` | No | `development` \| `production` \| `test`. |
| `PORT` | No | API port (default **3000**). |
| `DEEPSEEK_API_KEY` | No | If unset, `POST /api/transcription/cleanup` returns 503. |
| `DEEPSEEK_BASE_URL` | No | Default `https://api.deepseek.com`. |
| `DEEPSEEK_MODEL` | No | Default `deepseek-chat`. |

### Web (`apps/web/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SERVER_URL` | Yes | Base URL of the API (e.g. `http://localhost:3000`). |

---

## Scripts reference

| Script | Description |
|--------|-------------|
| `npm run dev` | Turborepo: web (Next) + server (Bun) in dev mode. |
| `npm run dev:web` | Next.js only on port 3001. |
| `npm run dev:server` | API only (Bun hot reload). |
| `npm run build` | Build all packages/apps that define a `build` task. |
| `npm run check-types` | Typecheck across the monorepo. |
| `npm run db:start` | `docker compose up -d` in `packages/db`. |
| `npm run db:stop` | Stop Compose services. |
| `npm run db:down` | Tear down Compose (including volumes if configured). |
| `npm run db:push` | Push Drizzle schema to Postgres. |
| `npm run db:generate` | Generate SQL migrations from schema changes. |
| `npm run db:migrate` | Run migrations (when using migration files). |
| `npm run db:studio` | Open Drizzle Studio. |
| `npm run check` / `npm run fix` | Ultracite lint / auto-fix (see `AGENTS.md`). |

---

## HTTP API (for grading and load tests)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health: plain text `OK`. |
| `POST` | `/api/chunks/upload` | Multipart form: `recordingId`, `chunkId`, `sequenceNo`, `durationMs`, `sizeBytes`, optional `checksum`, file field **`audio`** (WAV). |
| `GET` | `/api/chunks/recordings/:recordingId` | List ack rows for a recording. |
| `GET` | `/api/chunks/recordings/:recordingId/audit` | Same as list, plus `bucketPresent` per row (S3 `HeadObject`). |
| `POST` | `/api/transcription/cleanup` | JSON `{ "text": "..." }` — optional; requires `DEEPSEEK_API_KEY`. |

Successful upload response includes `ok`, `ackedAt`, `objectKey`, `bucket`, `alreadyExisted`, etc.

---

## Load testing notes

Assignments may target high request volume (for example on the order of **300k** uploads). Important details:

- The live endpoint expects **multipart form data**, not a JSON body. Tools must attach a binary `audio` part and the metadata fields above.
- Use [k6](https://k6.io), [autocannon](https://github.com/mcollina/autocannon), or similar; configure concurrency and duration to match your rubric.
- Validate **consistency**: every ack in Postgres should correspond to an object that exists in the bucket; use `/audit` or direct S3 listing plus DB queries.
- For k6, use multipart requests (for example `http.file` for the audio part and form fields for ids and numbers). Dummy WAV bytes are acceptable if the server only checks size and persistence.

---

## Project structure

```
.
├── apps/
│   ├── web/                 # Next.js App Router, recorder UI, OPFS, uploads
│   └── server/              # Hono API, S3 upload, Drizzle writes, optional DeepSeek
├── packages/
│   ├── db/                  # Drizzle schema, docker-compose.yml, migrations output
│   ├── env/                 # Zod-validated env for server and web
│   ├── ui/                  # Shared shadcn-style components (Tailwind)
│   └── config/              # Shared TypeScript config
├── package.json             # Workspaces, turbo scripts
├── turbo.json
├── AGENTS.md                # Ultracite / lint standards for contributors
└── README.md                # This file
```

Internal package names use the `@my-better-t-app/*` scope from the template; functionality is unchanged.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|----------------|------------|
| Web shows “Set NEXT_PUBLIC_SERVER_URL” | Missing or invalid `.env.local` | Add `apps/web/.env.local` with a full URL. |
| Browser upload fails with CORS | `CORS_ORIGIN` does not match the page origin | Set `CORS_ORIGIN` exactly to the Next.js origin (scheme + host + port). |
| API crashes on startup | Invalid or missing server env | Compare with [Environment variables](#environment-variables); ensure Zod-valid URLs. |
| `db:push` fails | Postgres not running or wrong `DATABASE_URL` | Run `npm run db:start`; use port **5434** for the default Compose file. |
| S3 errors / 500 on upload | MinIO down or wrong bucket | Run Compose; confirm bucket `recordings` exists (check `minio-init` logs). |
| `bun: command not found` | Bun not installed | Install Bun and ensure it is on `PATH`. |

---

## Assignment objective (summary)

**Main objective:** In all reasonable failure modes (network loss, retries, tab restarts within the same origin), **recording data stays accurate**: chunks are not “lost” without the UI reflecting failure, and the system can **repair** missing bucket objects using OPFS plus `/audit`.

For questions about code style and automated checks, see **`AGENTS.md`**.
