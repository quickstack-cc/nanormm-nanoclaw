/**
 * nanormm bridge response handler.
 *
 * Claims onAction events whose questionId starts with `nrmact-` and POSTs
 * the corresponding action_id to the approval-bridge's
 * /api/nanoclaw/actions/execute/ or /api/nanoclaw/actions/reject/ endpoint
 * with Bearer auth and Slack user attribution headers.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerResponseHandler } from '../../response-registry.js';
import type { ResponsePayload } from '../../response-registry.js';
import { startInternalServer } from './internal-server.js';

const QUESTION_ID_PREFIX = 'nrmact-';

const env = readEnvFile(['NANORMM_BRIDGE_URL', 'NANORMM_BRIDGE_API_KEY']);
const BRIDGE_URL = env.NANORMM_BRIDGE_URL || 'http://host.docker.internal:8000';
const API_KEY = env.NANORMM_BRIDGE_API_KEY;

async function handleNanormmResponse(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith(QUESTION_ID_PREFIX)) return false;

  const actionId = payload.questionId.slice(QUESTION_ID_PREFIX.length);
  const userId = payload.userId ?? '';

  if (!API_KEY) {
    log.error('NANORMM_BRIDGE_API_KEY missing; cannot complete action', { actionId });
    return true;
  }

  const isApprove = payload.value === 'approve';
  const path = isApprove ? 'execute' : 'reject';
  const body = isApprove
    ? { token: actionId }
    : { token: actionId, reason: 'declined via Slack' };

  try {
    const res = await fetch(`${BRIDGE_URL}/api/nanoclaw/actions/${path}/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-Slack-User-ID': userId,
      },
      body: JSON.stringify(body),
    });
    const respBody = (await res.json()) as Record<string, unknown>;
    if (res.ok) {
      log.info(`nanormm action ${isApprove ? 'executed' : 'rejected'}`,
        { actionId, userId, message: respBody.message });
    } else {
      log.warn(`nanormm action ${path} failed`,
        { actionId, status: res.status, error: respBody.error });
    }
  } catch (err) {
    log.error(`nanormm bridge ${path} call errored`, { actionId, err });
  }
  return true;
}

registerResponseHandler(handleNanormmResponse);
log.info('nanormm bridge response handler registered');

// Start the localhost-bound inject endpoint so the bridge can post approval cards.
// Errors are swallowed-and-logged; nanoclaw stays up if the listener can't bind.
startInternalServer().catch((err) => {
  log.error('nanormm-bridge internal server failed to start', { err });
});
