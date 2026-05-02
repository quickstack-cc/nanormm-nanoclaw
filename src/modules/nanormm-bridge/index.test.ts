import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    NANORMM_BRIDGE_URL: 'http://bridge.test',
    NANORMM_BRIDGE_API_KEY: 'test-key',
  })),
}));

const handlers: any[] = [];
vi.mock('../../response-registry.js', () => ({
  registerResponseHandler: (h: any) => handlers.push(h),
}));

vi.mock('./internal-server.js', () => ({
  startInternalServer: vi.fn(async () => undefined),
}));

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as any;
});

describe('nanormm-bridge response handler', async () => {
  // Import once at the top to register the handler
  const indexModule = await import('./index.js');
  const handler = handlers[0];

  it('non-nrmact prefix is not claimed', async () => {
    const claimed = await handler({ questionId: 'other-x', value: 'approve', userId: 'U1' });
    expect(claimed).toBe(false);
  });

  it('approve POSTs /actions/execute/', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ message: 'ok' }), status: 200 });
    const claimed = await handler({ questionId: 'nrmact-act_a', value: 'approve', userId: 'U1' });
    expect(claimed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://bridge.test/api/nanoclaw/actions/execute/',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'X-Slack-User-ID': 'U1',
        }),
      }),
    );
  });

  it('reject POSTs /actions/reject/ with reason', async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ message: 'rejected' }), status: 200 });
    const claimed = await handler({ questionId: 'nrmact-act_b', value: 'reject', userId: 'U2' });
    expect(claimed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://bridge.test/api/nanoclaw/actions/reject/',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'X-Slack-User-ID': 'U2',
        }),
      }),
    );
    const callArg = fetchSpy.mock.calls[0][1];
    const body = JSON.parse(callArg.body);
    expect(body).toEqual({ token: 'act_b', reason: 'declined via Slack' });
  });
});
