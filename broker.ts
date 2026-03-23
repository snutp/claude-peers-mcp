#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Supports two modes:
 *   - Local (default): listens on 127.0.0.1:7899
 *   - Network (CLAUDE_PEERS_NETWORK=tailscale): listens on 0.0.0.0:7899
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { hostname } from "os";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME}/.claude-peers.db`;
const NETWORK_MODE = process.env.CLAUDE_PEERS_NETWORK === "tailscale";
const PEER_TIMEOUT_MS = 60_000; // remote peers expire after 60s without heartbeat
const MY_HOSTNAME = hostname();

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    machine_id TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    git_root TEXT,
    git_remote_url TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// --- DB migration for existing databases ---
// ALTER TABLE ADD COLUMN is idempotent-safe: catch "duplicate column" errors
for (const stmt of [
  "ALTER TABLE peers ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE peers ADD COLUMN git_remote_url TEXT",
]) {
  try { db.run(stmt); } catch { /* column already exists */ }
}

// --- Peer liveness ---

function isPeerAlive(peer: { pid: number; machine_id: string; last_seen: string }): boolean {
  if (peer.machine_id === MY_HOSTNAME || peer.machine_id === "") {
    // Local peer: check PID directly
    try {
      process.kill(peer.pid, 0);
      return true;
    } catch {
      return false;
    }
  } else {
    // Remote peer: heartbeat timeout
    const lastSeen = new Date(peer.last_seen).getTime();
    return (Date.now() - lastSeen) < PEER_TIMEOUT_MS;
  }
}

function cleanStalePeers() {
  const peers = db.query("SELECT id, pid, machine_id, last_seen FROM peers").all() as Array<{
    id: string; pid: number; machine_id: string; last_seen: string;
  }>;
  for (const peer of peers) {
    if (!isPeerAlive(peer)) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, machine_id, cwd, git_root, git_remote_url, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

const selectUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this (machine_id, pid) pair
  const existing = db.query(
    "SELECT id FROM peers WHERE machine_id = ? AND pid = ?"
  ).get(body.machine_id, body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  insertPeer.run(
    id, body.pid, body.machine_id, body.cwd, body.git_root,
    body.git_remote_url, body.tty, body.summary, now, now
  );
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): { ok: boolean; registered: boolean } {
  const peer = db.query("SELECT id FROM peers WHERE id = ?").get(body.id) as { id: string } | null;
  if (!peer) {
    // Peer was cleaned up (timeout, broker restart, etc.) — tell client to re-register
    return { ok: false, registered: false };
  }
  updateLastSeen.run(new Date().toISOString(), body.id);
  return { ok: true, registered: true };
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        // Match by git_root path (same machine) OR git_remote_url (cross-machine)
        const byRoot = selectPeersByGitRoot.all(body.git_root) as Peer[];
        if (body.git_remote_url) {
          const byRemote = db.query(
            "SELECT * FROM peers WHERE git_remote_url = ? AND git_root != ?"
          ).all(body.git_remote_url, body.git_root) as Peer[];
          peers = [...byRoot, ...byRemote];
        } else {
          peers = byRoot;
        }
      } else {
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer is still alive
  return peers.filter((p) => {
    if (isPeerAlive(p)) {
      return true;
    }
    deletePeer.run(p.id);
    return false;
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify sender is registered (prevents spoofing from unregistered processes)
  const sender = db.query("SELECT id FROM peers WHERE id = ?").get(body.from_id) as { id: string } | null;
  if (!sender) {
    return { ok: false, error: `Sender ${body.from_id} not registered` };
  }

  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];

  // Mark them as delivered
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }

  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

const listenHost = NETWORK_MODE ? "0.0.0.0" : "127.0.0.1";

Bun.serve({
  port: PORT,
  hostname: listenHost,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          return Response.json(handleHeartbeat(body as HeartbeatRequest));
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on ${listenHost}:${PORT} (db: ${DB_PATH})`);
