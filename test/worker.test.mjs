import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/worker.js';
import { verifySlackSignature } from '../src/slack.js';
import { nextSundayDate, weekKey } from '../src/utils.js';

const secret = 'offline-test-secret';
function signedRequest(body, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`).digest('hex');
  return new Request('https://worker.example.test', {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json',
      'X-Slack-Request-Timestamp': String(timestamp),
      'X-Slack-Signature': `v0=${signature}` },
  });
}

test('accepts a signed body and rejects tampering, stale requests and missing headers', async () => {
  const body = '{"type":"url_verification","challenge":"offline"}';
  assert.equal(await verifySlackSignature(signedRequest(body), body, secret), true);
  assert.equal(await verifySlackSignature(signedRequest(body), body + ' ', secret), false);
  assert.equal(await verifySlackSignature(signedRequest(body, Math.floor(Date.now() / 1000) - 301), body, secret), false);
  assert.equal(await verifySlackSignature(new Request('https://worker.example.test'), body, secret), false);
});

test('unsigned POST and unsupported methods cannot invoke external services', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network access'); });
  const env = { SLACK_SIGNING_SECRET: secret };
  assert.equal((await worker.fetch(new Request('https://worker.example.test'), env, {})).status, 405);
  assert.equal((await worker.fetch(new Request('https://worker.example.test', { method: 'POST', body: '{}' }), env, {})).status, 401);
});

test('signed verification handshake returns the challenge without scheduling work', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network access'); });
  const body = '{"type":"url_verification","challenge":"offline"}';
  const response = await worker.fetch(signedRequest(body), { SLACK_SIGNING_SECRET: secret }, {
    waitUntil() { assert.fail('Verification must not schedule work'); },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: 'offline' });
});

for (const [instant, expected] of [
  ['2026-01-03T11:30:00Z', '2026-01-11'], // Sunday in NZDT, Saturday UTC
  ['2026-07-04T12:30:00Z', '2026-07-12'], // Sunday in NZST, Saturday UTC
  ['2026-12-31T11:30:00Z', '2027-01-03'], // NZ new year
]) {
  test(`next Sunday follows Auckland time at ${instant}`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date(instant) });
    assert.equal(nextSundayDate(), expected);
  });
}

test('campus keys separate same-week plans and retain the legacy key', () => {
  assert.equal(weekKey('2026-07-12', 'North'), 'week:2026-07-12:North');
  assert.equal(weekKey('2026-07-12', 'Central'), 'week:2026-07-12:Central');
  assert.equal(weekKey('2026-07-12'), 'week:2026-07-12');
});
