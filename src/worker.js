/**
 * worker.js - Main Cloudflare Worker entry point
 *
 * Three entry points:
 *  1. fetch()     - Handles Slack Events API webhooks, slash commands, and modal submissions
 *  2. scheduled() - Saturday safety-net cron (checks if plan was received for any campus)
 *
 * Request type detection (all share the same URL):
 *  - Events API:        application/json with `type` field
 *  - Slash command:     application/x-www-form-urlencoded with `command` field
 *  - Modal submission:  application/x-www-form-urlencoded with `payload` JSON
 */

import { verifySlackSignature, postMessage, editMessage, postReply, openModal, postEphemeral } from './slack.js';
import { fetchNextSundayPlan, applyChangesToPco } from './pco.js';
import { classifyMessage, analyzePlan, refinePlan } from './claude.js';
import { nextSundayDate, weekKey } from './utils.js';

export default {
  // ─────────────────────────────────────────────
  // HTTP HANDLER
  // ─────────────────────────────────────────────
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const rawBody = await request.text();

    // Verify the request really came from Slack (applies to all payload types)
    const isValid = await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET);
    if (!isValid) {
      return new Response('Unauthorized', { status: 401 });
    }

    const contentType = request.headers.get('Content-Type') ?? '';

    // ── Slash command or interactive payload (modal submission) ──
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(rawBody);

      if (params.has('command')) {
        return handleSlashCommand(params, env);
      }

      if (params.has('payload')) {
        const interactive = JSON.parse(params.get('payload'));
        if (interactive.type === 'view_submission' && interactive.view?.callback_id === 'plan_setup') {
          // Respond immediately to close the modal; do KV write + ephemeral async
          ctx.waitUntil(
            handleInteractivePayload(interactive, env).catch((err) =>
              console.error('Interactive payload error:', err),
            ),
          );
          return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        }
      }

      return new Response('OK');
    }

    // ── Events API (application/json) ──
    const payload = JSON.parse(rawBody);

    // URL verification handshake (one-time Slack setup)
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

    // Find all channels that have campuses configured
    const { keys } = await env.STATE.list({ prefix: 'campuses:' });

    if (keys.length === 0) {
      console.log('Safety-net cron: no campuses configured.');
      return;
    }

    for (const { name } of keys) {
      const channelId = name.slice('campuses:'.length);
      const campuses = await env.STATE.get(name, { type: 'json' });
      if (!campuses || campuses.length === 0) continue;

      const states = await Promise.all(
        campuses.map((c) => env.STATE.get(weekKey(sunday, c.campus_name), { type: 'json' })),
      );

      const anyMissing = states.some((s) => !s?.plan_received);
      if (!anyMissing) {
        console.log(`Safety-net cron: all campuses have received plans for ${channelId}.`);
        continue;
      }

      await postMessage(
        channelId,
        `Hey, just checking — has the service plan for this Sunday been posted yet? I haven't seen it come through.`,
        env.SLACK_BOT_TOKEN,
      );

      console.log(`Safety-net cron: nudge posted for ${channelId}.`);
    }
  },
};

// ─────────────────────────────────────────────
// EVENT DISPATCHER
// ─────────────────────────────────────────────
async function handleEvent(event, env) {
  // ── Bot invited to channel ──
  if (event.type === 'member_joined_channel') {
    await handleMemberJoined(event, env);
    return;
  }

  // ── New top-level message ──
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
// MEMBER JOINED CHANNEL
// ─────────────────────────────────────────────
async function handleMemberJoined(event, env) {
  // Only act when the bot itself joins (not when other users join)
  if (event.user !== env.SLACK_BOT_USER_ID) return;

  // Only prompt if no campuses are configured yet for this channel
  const campuses = await env.STATE.get(`campuses:${event.channel}`, { type: 'json' });
  if (campuses && campuses.length > 0) return;

  if (!event.inviter) return;

  await postEphemeral(
    event.channel,
    event.inviter,
    "I've been added to this channel. Run `/plan-setup` to configure a campus.",
    env.SLACK_BOT_TOKEN,
  );
}

// ─────────────────────────────────────────────
// SLASH COMMAND — /plan-setup
// ─────────────────────────────────────────────
async function handleSlashCommand(params, env) {
  const triggerId = params.get('trigger_id');
  const channelId = params.get('channel_id');

  const modal = {
    type: 'modal',
    callback_id: 'plan_setup',
    title: { type: 'plain_text', text: 'Campus Setup' },
    submit: { type: 'plain_text', text: 'Save' },
    // Pass the channel ID through so the submission handler knows where to save
    private_metadata: channelId,
    blocks: [
      {
        type: 'input',
        block_id: 'campus_name',
        label: { type: 'plain_text', text: 'Campus Name' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'e.g. North Campus' },
        },
      },
      {
        type: 'input',
        block_id: 'service_type_id',
        label: { type: 'plain_text', text: 'PCO Service Type ID' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Found in the PCO URL (e.g. 12345678)' },
        },
      },
      {
        type: 'input',
        block_id: 'approver',
        label: { type: 'plain_text', text: 'Approver' },
        element: {
          type: 'users_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Select who approves PCO changes' },
        },
      },
    ],
  };

  await openModal(triggerId, modal, env.SLACK_BOT_TOKEN);
  return new Response('', { status: 200 });
}

// ─────────────────────────────────────────────
// INTERACTIVE PAYLOAD — modal submission
// ─────────────────────────────────────────────
async function handleInteractivePayload(payload, env) {
  const channelId = payload.view.private_metadata;
  const values = payload.view.state.values;

  const campusName = values.campus_name.value.value;
  const serviceTypeId = values.service_type_id.value.value;
  const approverUserId = values.approver.value.selected_user;

  // Load existing campuses and upsert by campus name
  const campuses = (await env.STATE.get(`campuses:${channelId}`, { type: 'json' })) ?? [];
  const idx = campuses.findIndex((c) => c.campus_name === campusName);
  const entry = { campus_name: campusName, service_type_id: serviceTypeId, approver_user_id: approverUserId };

  if (idx >= 0) {
    campuses[idx] = entry;
  } else {
    campuses.push(entry);
  }

  await env.STATE.put(`campuses:${channelId}`, JSON.stringify(campuses));
  await postEphemeral(channelId, payload.user.id, `${campusName} configured.`, env.SLACK_BOT_TOKEN);
}

// ─────────────────────────────────────────────
// NEW CHANNEL MESSAGE
// ─────────────────────────────────────────────
async function handleNewChannelMessage(event, env) {
  const text = event.text ?? '';

  // Step 1: cheap classification — is this the weekly plan?
  const isServicePlan = await classifyMessage(text, env.ANTHROPIC_API_KEY);
  if (!isServicePlan) {
    console.log('Classification: not a service plan. Ignoring.');
    return;
  }

  console.log('Classification: service plan detected. Running full analysis.');

  // Step 2: load all configured campuses for this channel
  const campuses = await env.STATE.get(`campuses:${event.channel}`, { type: 'json' });
  if (!campuses || campuses.length === 0) {
    console.log('No campuses configured for this channel.');
    return;
  }

  const sunday = nextSundayDate();

  // Step 3: process each campus in parallel
  await Promise.all(campuses.map((campus) => processCampusPlan(text, event, campus, sunday, env)));
}

async function processCampusPlan(text, event, campus, sunday, env) {
  const pcoPlan = await fetchNextSundayPlan(env.PCO_APP_ID, env.PCO_SECRET, campus.service_type_id);
  const analysis = await analyzePlan(text, pcoPlan, env.ANTHROPIC_API_KEY);
  const replyText = formatAnalysisReply(analysis, pcoPlan, sunday, campus.campus_name);

  const botReply = await postMessage(event.channel, replyText, env.SLACK_BOT_TOKEN);

  await env.STATE.put(
    weekKey(sunday, campus.campus_name),
    JSON.stringify({
      plan_received: true,
      slack_channel_id: event.channel,
      slack_message_ts: event.ts,
      bot_reply_ts: botReply.ts,
      pco_plan_id: pcoPlan.id,
      proposed_changes: analysis.proposed_changes,
      manual_steps: analysis.manual_steps,
      applied: false,
      // Store campus config in state for use during thread replies and reactions
      campus_name: campus.campus_name,
      service_type_id: campus.service_type_id,
      approver_user_id: campus.approver_user_id,
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
  const { stored, key } = await findCampusStateByTs(event.channel, event.thread_ts, sunday, env);

  if (!stored) return;

  if (stored.applied) {
    await postReply(
      event.channel,
      event.thread_ts,
      'This plan has already been applied to Planning Center.',
      env.SLACK_BOT_TOKEN,
    );
    return;
  }

  const pcoPlan = await fetchNextSundayPlan(env.PCO_APP_ID, env.PCO_SECRET, stored.service_type_id);
  const refined = await refinePlan(event.text, stored, pcoPlan, env.ANTHROPIC_API_KEY);

  const updatedText =
    formatAnalysisReply(refined, pcoPlan, sunday, stored.campus_name) +
    '\n\n_Plan updated based on your feedback._';

  await editMessage(event.channel, stored.bot_reply_ts, updatedText, env.SLACK_BOT_TOKEN);

  await env.STATE.put(key, JSON.stringify({
    ...stored,
    proposed_changes: refined.proposed_changes,
    manual_steps: refined.manual_steps,
  }));
}

// ─────────────────────────────────────────────
// REACTION ADDED (checkmark approval)
// ─────────────────────────────────────────────
async function handleReaction(event, env) {
  const isCheckmark = event.reaction === 'white_check_mark' || event.reaction === 'heavy_check_mark';
  if (!isCheckmark) return;

  const channel = event.item?.channel;
  const sunday = nextSundayDate();
  const { stored, key } = await findCampusStateByTs(channel, event.item?.ts, sunday, env);

  if (!stored) return;
  if (stored.applied) return;

  // Only the configured approver for this campus can trigger PCO writes
  if (event.user !== stored.approver_user_id) return;

  const results = await applyChangesToPco(
    stored.pco_plan_id,
    stored.proposed_changes,
    env.PCO_APP_ID,
    env.PCO_SECRET,
  );

  const summary = results
    .map((r) => (r.ok ? `- Applied: ${r.description}` : `- FAILED: ${r.description} (${r.error})`))
    .join('\n');

  await postReply(
    channel,
    stored.bot_reply_ts,
    `Changes applied to Planning Center:\n${summary}`,
    env.SLACK_BOT_TOKEN,
  );

  await env.STATE.put(key, JSON.stringify({ ...stored, applied: true }));
}

// ─────────────────────────────────────────────
// FIND CAMPUS STATE BY BOT MESSAGE TIMESTAMP
// ─────────────────────────────────────────────

/**
 * Searches all configured campuses for the one whose bot_reply_ts matches `ts`.
 * Returns { stored, key } for the matching campus, or { stored: null, key: null }.
 */
async function findCampusStateByTs(channelId, ts, sunday, env) {
  const campuses = await env.STATE.get(`campuses:${channelId}`, { type: 'json' });
  if (!campuses || campuses.length === 0) return { stored: null, key: null };

  for (const campus of campuses) {
    const key = weekKey(sunday, campus.campus_name);
    const state = await env.STATE.get(key, { type: 'json' });
    if (state?.bot_reply_ts === ts) {
      return { stored: state, key };
    }
  }

  return { stored: null, key: null };
}

// ─────────────────────────────────────────────
// FORMAT SLACK REPLY
// ─────────────────────────────────────────────
function formatAnalysisReply(analysis, pcoPlan, sunday, campusName) {
  const { proposed_changes = [], manual_steps = [], roster_issues = [] } = analysis;

  const campusPrefix = campusName ? `${campusName}: ` : '';
  const lines = [`*${campusPrefix}Service Plan Analysis — Sunday ${sunday}*\n`];

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
