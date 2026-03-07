/**
 * worker.js - Main Cloudflare Worker entry point
 *
 * Two entry points:
 *  1. fetch()     - Handles Slack Events API webhooks
 *  2. scheduled() - Saturday safety-net cron (checks if plan was received)
 */

import { verifySlackSignature, postMessage, editMessage, postReply } from './slack.js';
import { fetchNextSundayPlan, applyChangesToPco } from './pco.js';
import { classifyMessage, analyzePlan, refinePlan } from './claude.js';
import { nextSundayDate, weekKey } from './utils.js';

export default {
  // ─────────────────────────────────────────────
  // HTTP HANDLER – Slack Events API
  // ─────────────────────────────────────────────
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const rawBody = await request.text();

    // Verify the request really came from Slack
    const isValid = await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET);
    if (!isValid) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = JSON.parse(rawBody);

    // ── URL verification handshake (one-time Slack setup) ──
    if (payload.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (payload.type !== 'event_callback') {
      return new Response('OK');
    }

    const event = payload.event;

    // Use ctx.waitUntil so the Worker stays alive until async work completes
    // even after the HTTP response is returned to Slack (3-second window).
    ctx.waitUntil(
      handleEvent(event, env).catch((err) => console.error('Event handler error:', err)),
    );

    return new Response('OK');
  },

  // ─────────────────────────────────────────────
  // CRON HANDLER – Saturday safety-net
  // ─────────────────────────────────────────────
  async scheduled(controller, env) {
    const sunday = nextSundayDate();
    const key = weekKey(sunday);
    const stored = await env.STATE.get(key, { type: 'json' });

    if (stored?.plan_received) {
      console.log(`Safety-net cron: plan already received for ${sunday}. Nothing to do.`);
      return;
    }

    await postMessage(
      env.SLACK_CHANNEL_ID,
      "Hey, just checking — has the service plan for this Sunday been posted yet? I haven't seen it come through.",
      env.SLACK_BOT_TOKEN,
    );

    console.log(`Safety-net cron: nudge posted for ${sunday}.`);
  },
};

// ─────────────────────────────────────────────
// EVENT DISPATCHER
// ─────────────────────────────────────────────
async function handleEvent(event, env) {
  // Only care about messages in our target channel
  if (event.channel !== env.SLACK_CHANNEL_ID) return;

  // ── New message in the group channel ──
  if (event.type === 'message' && event.subtype == null && !event.thread_ts) {
    await handleNewChannelMessage(event, env);
    return;
  }

  // ── Thread reply (refinement) ──
  if (event.type === 'message' && event.thread_ts && event.thread_ts !== event.ts) {
    await handleThreadReply(event, env);
    return;
  }

  // ── Reaction added ──
  if (event.type === 'reaction_added') {
    await handleReaction(event, env);
    return;
  }
}

// ─────────────────────────────────────────────
// NEW CHANNEL MESSAGE
// ─────────────────────────────────────────────
async function handleNewChannelMessage(event, env) {
  const text = event.text ?? '';

  // Step 1: cheap classification – is this the weekly plan?
  const isServicePlan = await classifyMessage(text, env.ANTHROPIC_API_KEY);
  if (!isServicePlan) {
    console.log('Classification: not a service plan. Ignoring.');
    return;
  }

  console.log('Classification: service plan detected. Running full analysis.');

  // Step 2: fetch PCO plan
  const sunday = nextSundayDate();
  const pcoPlan = await fetchNextSundayPlan(env.PCO_APP_ID, env.PCO_SECRET, env.SERVICE_TYPE_ID);

  // Step 3: full analysis via Claude
  const analysis = await analyzePlan(text, pcoPlan, env.ANTHROPIC_API_KEY);

  // Step 4: build the reply text
  const replyText = formatAnalysisReply(analysis, pcoPlan, sunday);

  // Step 5: post reply in thread
  const botReply = await postReply(
    env.SLACK_CHANNEL_ID,
    event.ts,
    replyText,
    env.SLACK_BOT_TOKEN,
  );

  // Step 6: persist to KV
  const key = weekKey(sunday);
  await env.STATE.put(
    key,
    JSON.stringify({
      plan_received: true,
      slack_channel_id: event.channel,
      slack_message_ts: event.ts,
      bot_reply_ts: botReply.ts,
      pco_plan_id: pcoPlan.id,
      proposed_changes: analysis.proposed_changes,
      manual_steps: analysis.manual_steps,
      applied: false,
    }),
  );
}

// ─────────────────────────────────────────────
// THREAD REPLY (refinement)
// ─────────────────────────────────────────────
async function handleThreadReply(event, env) {
  // Ignore bot's own messages
  if (event.bot_id) return;

  const sunday = nextSundayDate();
  const key = weekKey(sunday);
  const stored = await env.STATE.get(key, { type: 'json' });

  if (!stored) return;

  // Only respond to replies in our bot's thread
  if (event.thread_ts !== stored.bot_reply_ts && event.thread_ts !== stored.slack_message_ts) {
    return;
  }

  if (stored.applied) {
    await postReply(
      env.SLACK_CHANNEL_ID,
      event.thread_ts,
      'This plan has already been applied to Planning Center.',
      env.SLACK_BOT_TOKEN,
    );
    return;
  }

  const pcoPlan = await fetchNextSundayPlan(env.PCO_APP_ID, env.PCO_SECRET, env.SERVICE_TYPE_ID);
  const refined = await refinePlan(event.text, stored, pcoPlan, env.ANTHROPIC_API_KEY);

  // Update the bot's message with revised plan
  const updatedText = formatAnalysisReply(refined, pcoPlan, sunday) +
    '\n\n_Plan updated based on your feedback._';

  await editMessage(
    env.SLACK_CHANNEL_ID,
    stored.bot_reply_ts,
    updatedText,
    env.SLACK_BOT_TOKEN,
  );

  // Persist updated plan
  await env.STATE.put(
    key,
    JSON.stringify({
      ...stored,
      proposed_changes: refined.proposed_changes,
      manual_steps: refined.manual_steps,
    }),
  );
}

// ─────────────────────────────────────────────
// REACTION ADDED (checkmark approval)
// ─────────────────────────────────────────────
async function handleReaction(event, env) {
  // Only respond to white_check_mark or heavy_check_mark from the approved user
  const isCheckmark = event.reaction === 'white_check_mark' || event.reaction === 'heavy_check_mark';
  if (!isCheckmark) return;
  if (event.user !== env.APPROVAL_SLACK_USER_ID) return;

  const sunday = nextSundayDate();
  const key = weekKey(sunday);
  const stored = await env.STATE.get(key, { type: 'json' });

  if (!stored) return;
  if (stored.applied) return;

  // Verify the reaction is on the bot's reply message
  if (event.item?.ts !== stored.bot_reply_ts) return;

  // Apply all changes to PCO
  const results = await applyChangesToPco(
    stored.pco_plan_id,
    stored.proposed_changes,
    env.PCO_APP_ID,
    env.PCO_SECRET,
  );

  // Post confirmation
  const summary = results
    .map((r) => (r.ok ? `- Applied: ${r.description}` : `- FAILED: ${r.description} (${r.error})`))
    .join('\n');

  await postReply(
    env.SLACK_CHANNEL_ID,
    stored.slack_message_ts,
    `Changes applied to Planning Center:\n${summary}`,
    env.SLACK_BOT_TOKEN,
  );

  // Mark as applied
  await env.STATE.put(key, JSON.stringify({ ...stored, applied: true }));
}

// ─────────────────────────────────────────────
// FORMAT SLACK REPLY
// ─────────────────────────────────────────────
function formatAnalysisReply(analysis, pcoPlan, sunday) {
  const { proposed_changes = [], manual_steps = [], roster_issues = [] } = analysis;

  const lines = [`*Service Plan Analysis — Sunday ${sunday}*\n`];

  lines.push('*Proposed Changes* (react :white_check_mark: to apply to Planning Center):');
  if (proposed_changes.length === 0) {
    lines.push('- No changes needed.');
  } else {
    for (const c of proposed_changes) {
      lines.push(`- ${formatChange(c)}`);
    }
  }

  if (roster_issues.length > 0) {
    lines.push('\n*Roster Check:*');
    for (const r of roster_issues) {
      lines.push(`- ${r}`);
    }
  }

  if (manual_steps.length > 0) {
    lines.push('\n*Manual Steps Needed:*');
    for (const s of manual_steps) {
      lines.push(`- ${s}`);
    }
  }

  lines.push('\n_Reply in this thread to refine, or react :white_check_mark: to apply as-is._');

  return lines.join('\n');
}

function formatChange(change) {
  switch (change.type) {
    case 'notice_title':
      return `[${change.item_title ?? 'Notice'}] Title updated → "${change.new_title}"`;
    case 'remove_empty_notice':
      return `[${change.item_title ?? 'Notice'}] Removed (no description)`;
    case 'remove_empty_highlight':
      return `[Highlight] Removed (no content)`;
    case 'fill_placeholder':
      return `[${change.item_title ?? change.role}] Placeholder → "${change.volunteer_name}"`;
    default:
      return JSON.stringify(change);
  }
}
