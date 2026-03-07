/**
 * slack.js - Slack API helpers
 *
 * Uses the native fetch() available in Cloudflare Workers rather than the
 * @slack/web-api SDK, because the SDK pulls in Node.js-specific modules that
 * are not available in the Workers runtime.  The raw Web API calls are simple
 * enough to do directly.
 */

const SLACK_API = 'https://slack.com/api';

// ─────────────────────────────────────────────
// REQUEST VERIFICATION
// ─────────────────────────────────────────────

/**
 * Verifies the X-Slack-Signature header to confirm the request came from Slack.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(request, rawBody, signingSecret) {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  const slackSig = request.headers.get('X-Slack-Signature');

  if (!timestamp || !slackSig) return false;

  // Reject requests older than 5 minutes to prevent replay attacks
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (Number(timestamp) < fiveMinutesAgo) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBase));
  const computed = 'v0=' + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (computed.length !== slackSig.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ slackSig.charCodeAt(i);
  }
  return diff === 0;
}

// ─────────────────────────────────────────────
// MESSAGE HELPERS
// ─────────────────────────────────────────────

/**
 * Post a message to a channel (not threaded).
 * Returns the full Slack API response.
 */
export async function postMessage(channelId, text, botToken) {
  return slackCall('chat.postMessage', botToken, { channel: channelId, text });
}

/**
 * Post a reply in a thread.
 * Returns the full Slack API response (including .ts of the new message).
 */
export async function postReply(channelId, threadTs, text, botToken) {
  return slackCall('chat.postMessage', botToken, {
    channel: channelId,
    thread_ts: threadTs,
    text,
  });
}

/**
 * Edit an existing message (used to update the bot's analysis reply).
 */
export async function editMessage(channelId, messageTs, text, botToken) {
  return slackCall('chat.update', botToken, {
    channel: channelId,
    ts: messageTs,
    text,
  });
}

/**
 * Open a Slack modal using a trigger_id from a slash command.
 */
export async function openModal(triggerId, modal, botToken) {
  return slackCall('views.open', botToken, { trigger_id: triggerId, view: modal });
}

/**
 * Post an ephemeral message visible only to a specific user in a channel.
 */
export async function postEphemeral(channelId, userId, text, botToken) {
  return slackCall('chat.postEphemeral', botToken, { channel: channelId, user: userId, text });
}

/**
 * Fetch messages from a channel (for lookups if needed).
 */
export async function getChannelHistory(channelId, botToken, { limit = 10, oldest } = {}) {
  const params = { channel: channelId, limit };
  if (oldest) params.oldest = oldest;
  return slackCall('conversations.history', botToken, params);
}

// ─────────────────────────────────────────────
// LOW-LEVEL HELPER
// ─────────────────────────────────────────────

async function slackCall(method, botToken, body) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!data.ok) {
    throw new Error(`Slack API error on ${method}: ${data.error}`);
  }

  return data;
}
