/**
 * nanormm bridge response handler.
 *
 * Claims onAction events whose questionId starts with `nrmact-` and POSTs
 * the corresponding action_id to the approval-bridge's
 * /api/nanoclaw/actions/execute/ endpoint with Bearer auth and Slack user
 * attribution headers.
 *
 * Reject (value !== 'approve') currently no-ops here — the click is claimed
 * and chat-sdk-bridge updates the card visually, but we don't call the
 * bridge's /reject/ endpoint. Plan 4+ may wire that.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerResponseHandler } from '../../response-registry.js';
import type { ResponsePayload } from '../../response-registry.js';

const QUESTION_ID_PREFIX = 'nrmact-';

const env = readEnvFile(['NANORMM_BRIDGE_URL', 'NANORMM_BRIDGE_API_KEY']);
const BRIDGE_URL = env.NANORMM_BRIDGE_URL || 'http://host.docker.internal:8000';
const API_KEY = env.NANORMM_BRIDGE_API_KEY;

async function handleNanormmResponse(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith(QUESTION_ID_PREFIX)) return false;

  const actionId = payload.questionId.slice(QUESTION_ID_PREFIX.length);
  const userId = payload.userId ?? '';

  if (payload.value !== 'approve') {
    log.info('nanormm action rejected (claimed, no bridge call)', { actionId, userId });
    return true;
  }

  if (!API_KEY) {
    log.error('NANORMM_BRIDGE_API_KEY missing; cannot execute approved action', { actionId });
    return true;
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/api/nanoclaw/actions/execute/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-Slack-User-ID': userId,
      },
      body: JSON.stringify({ token: actionId }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.ok) {
      log.info('nanormm action executed', { actionId, userId, message: body.message });
    } else {
      log.warn('nanormm action execution failed', { actionId, status: res.status, error: body.error });
    }
  } catch (err) {
    log.error('nanormm bridge call errored', { actionId, err });
  }
  return true;
}

registerResponseHandler(handleNanormmResponse);
log.info('nanormm bridge response handler registered');
