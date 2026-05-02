/**
 * Localhost-bound HTTP server that accepts approval-card injection requests
 * from the bridge. Writes a chat-sdk ask_question row into the session's
 * outbound.db (messages_out table); the existing delivery poll then renders
 * & posts the Slack card.
 *
 * Endpoint: POST /internal/sessions/:id/inject-card
 *   body: { questionId, title, question, options }
 *   202: row written
 *   404: session not found, session has no messaging_group_id, or non-matching path/method
 *   400: malformed body
 */
import http from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { log } from '../../log.js';
import { getSession } from '../../db/sessions.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';

const DEFAULT_PORT = 8765;
const DATA_DIR = process.env.NANOCLAW_DATA_DIR ?? '/opt/nanoclaw/data';

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

interface InjectBody {
  questionId: string;
  title: string;
  question: string;
  options: Array<{ label: string; selectedLabel?: string; value: string }>;
}

function isInjectBody(b: unknown): b is InjectBody {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return typeof o.questionId === 'string'
    && typeof o.title === 'string'
    && typeof o.question === 'string'
    && Array.isArray(o.options);
}

/**
 * Read max(seq) from messages_out, return next EVEN value.
 * Container writes odd seq (1,3,5…); host writes even (2,4,6…).
 */
function nextEvenOutSeq(db: Database.Database): number {
  const max = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  return max < 2 ? 2 : max + 2 - (max % 2);
}

export async function startInternalServer(): Promise<http.Server> {
  const port = Number(process.env.NANOCLAW_INTERNAL_PORT ?? DEFAULT_PORT);
  const server = http.createServer(async (req, res) => {
    const m = req.url?.match(/^\/internal\/sessions\/([^/]+)\/inject-card$/);
    if (!m || req.method !== 'POST') {
      return send(res, 404, { error: 'not found' });
    }
    const sessionId = m[1];

    const session = getSession(sessionId);
    if (!session) {
      return send(res, 404, { error: 'unknown session' });
    }
    if (!session.messaging_group_id) {
      return send(res, 404, { error: 'session has no messaging_group_id' });
    }
    const mg = getMessagingGroup(session.messaging_group_id);
    if (!mg) {
      return send(res, 404, { error: 'unknown messaging_group' });
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: 'malformed json' });
    }
    if (!isInjectBody(body)) {
      return send(res, 400, { error: 'missing required fields' });
    }

    const messageId = `inj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dataDir = process.env.NANOCLAW_DATA_DIR ?? DATA_DIR;
    const outboundPath = path.join(
      dataDir, 'v2-sessions', session.agent_group_id, session.id, 'outbound.db',
    );

    const outDb = new Database(outboundPath);
    let seq: number;
    try {
      seq = nextEvenOutSeq(outDb);
      outDb.prepare(`
        INSERT INTO messages_out
          (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
        VALUES
          (?, ?, NULL, datetime('now'), NULL, NULL, 'normal', ?, ?, ?, ?)
      `).run(
        messageId,
        seq,
        mg.platform_id,
        mg.channel_type,
        session.thread_id,
        JSON.stringify({
          type: 'ask_question',
          questionId: body.questionId,
          title: body.title,
          question: body.question,
          options: body.options,
        }),
      );
    } finally {
      outDb.close();
    }

    log.info('nanormm-bridge inject-card written', {
      sessionId, messageId, seq, questionId: body.questionId,
    });
    return send(res, 202, { accepted: true, messageId, seq });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      log.info('nanormm-bridge internal server listening', { port: actualPort });
      resolve(server);
    });
  });
}
