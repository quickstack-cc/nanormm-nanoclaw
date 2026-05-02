import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));

const sessionMock = vi.hoisted(() => ({ value: null as any }));
const mgMock = vi.hoisted(() => ({ value: null as any }));

vi.mock('../../db/sessions.js', () => ({
  getSession: vi.fn((id: string) => sessionMock.value?.id === id ? sessionMock.value : undefined),
}));
// getMessagingGroup (not getMessagingGroupById) per src/db/messaging-groups.ts
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn((id: string) => mgMock.value?.id === id ? mgMock.value : undefined),
}));

import { startInternalServer } from './internal-server.js';

let server: http.Server;
let port: number;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'plan4-test-'));
  process.env.NANOCLAW_INTERNAL_PORT = '0';
  process.env.NANOCLAW_DATA_DIR = tmpDir;
  server = await startInternalServer();
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterEach(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  sessionMock.value = null;
  mgMock.value = null;
});

const MESSAGES_OUT_SCHEMA = `
  CREATE TABLE messages_out (
    id             TEXT PRIMARY KEY,
    seq            INTEGER UNIQUE,
    in_reply_to    TEXT,
    timestamp      TEXT NOT NULL,
    deliver_after  TEXT,
    recurrence     TEXT,
    kind           TEXT NOT NULL,
    platform_id    TEXT,
    channel_type   TEXT,
    thread_id      TEXT,
    content        TEXT NOT NULL
  );
`;

describe('internal-server', () => {
  it('returns 404 for unknown session', async () => {
    sessionMock.value = null;
    const r = await fetch(`http://127.0.0.1:${port}/internal/sessions/no-such/inject-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'nrmact-x', title: 't', question: 'q', options: [] }),
    });
    expect(r.status).toBe(404);
  });

  it('returns 404 for non-POST', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/internal/sessions/anything/inject-card`);
    expect(r.status).toBe(404);
  });

  it('returns 400 for malformed body', async () => {
    sessionMock.value = { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1', thread_id: 't1' };
    mgMock.value = { id: 'mg-1', channel_type: 'slack', platform_id: 'C0X' };
    const r = await fetch(`http://127.0.0.1:${port}/internal/sessions/sess-1/inject-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  it('returns 404 when session has no messaging_group_id', async () => {
    sessionMock.value = { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: null, thread_id: null };
    mgMock.value = null;
    const r = await fetch(`http://127.0.0.1:${port}/internal/sessions/sess-1/inject-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'nrmact-x', title: 't', question: 'q', options: [] }),
    });
    expect(r.status).toBe(404);
  });

  it('writes ask_question row to messages_out on success', async () => {
    const sessionsDir = path.join(tmpDir, 'v2-sessions', 'ag-1', 'sess-1');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const outDb = new Database(path.join(sessionsDir, 'outbound.db'));
    outDb.exec(MESSAGES_OUT_SCHEMA);
    outDb.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('seed-1', 7, datetime('now'), 'normal', '{}')`
    ).run();
    outDb.close();

    sessionMock.value = {
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: '1700000000.123456',
    };
    mgMock.value = {
      id: 'mg-1',
      channel_type: 'slack',
      platform_id: 'C0123456',
    };

    const r = await fetch(`http://127.0.0.1:${port}/internal/sessions/sess-1/inject-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questionId: 'nrmact-act_xyz',
        title: 'Pending action',
        question: 'Kill PID 1234',
        options: [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
        ],
      }),
    });
    expect(r.status).toBe(202);

    const verify = new Database(path.join(sessionsDir, 'outbound.db'));
    const rows = verify.prepare(
      `SELECT id, seq, kind, platform_id, channel_type, thread_id, content, deliver_after, timestamp
       FROM messages_out WHERE id != 'seed-1'`
    ).all() as any[];
    verify.close();

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.kind).toBe('normal');
    expect(row.platform_id).toBe('C0123456');
    expect(row.channel_type).toBe('slack');
    expect(row.thread_id).toBe('1700000000.123456');
    expect(row.deliver_after).toBeNull();
    expect(typeof row.timestamp).toBe('string');
    expect(row.seq % 2).toBe(0);                   // host writes even seq
    expect(row.seq).toBeGreaterThan(7);            // bumped past the seeded odd seq

    const content = JSON.parse(row.content);
    expect(content.type).toBe('ask_question');
    expect(content.questionId).toBe('nrmact-act_xyz');
    expect(content.title).toBe('Pending action');
    expect(content.question).toBe('Kill PID 1234');
    expect(content.options).toHaveLength(2);
  });
});
