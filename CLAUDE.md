# CLAUDE.md — Architecture & Design Reference

This file describes the original architecture plan for this project so that Claude
can understand the intent and design decisions when making future changes.

---

## What This Project Does

This is a Cloudflare Worker that automates the weekly service plan workflow for one or
more campuses sharing a single Slack channel. The operator (magnification driver)
previously had to manually read the service plan posted in a private Slack channel,
cross-reference it against the Planning Center Online (PCO) plan, fix recurring issues
(notice titles, placeholder names, empty items), and check volunteer roster gaps.
This project automates all of that, and can serve multiple campuses from one bot instance.

Campuses are configured via the `/plan-setup` slash command — per-campus settings
(campus name, PCO service type ID, approver) are stored in KV, not in secrets.

---

## Architecture: Event-Driven + Safety Net Cron

All logic runs in a single Cloudflare Worker with two entry points. The same URL
receives three Slack payload types, distinguished by Content-Type:

| Source | Content-Type | Detection |
|--------|-------------|-----------|
| Events API | `application/json` | JSON body, `type` field |
| Slash command | `application/x-www-form-urlencoded` | Form body has `command` field |
| Modal submission | `application/x-www-form-urlencoded` | Form body has `payload` JSON with `type: "view_submission"` |

```
1. HTTP HANDLER
   |
   +-- Slash command: /plan-setup
   |   |-- Open Slack modal (Campus Name, PCO Service Type ID, Approver)
   |   +-- On submit: upsert campus into campuses:CHANNEL_ID in KV
   |       Post ephemeral: "North Campus configured."
   |
   +-- Event: member_joined_channel
   |   |-- Only act if joining user is the bot itself
   |   +-- Only act if campuses:CHANNEL_ID doesn't exist yet
   |       Post ephemeral to inviter: "Run /plan-setup to configure a campus."
   |
   +-- Event: message.groups (new message in #weekly-service-plans)
   |   |
   |   |-- [Classification] Send message to Claude: yes / no
   |   |-- If NO: ignore
   |   +-- If YES: load campuses:CHANNEL_ID → for each campus in parallel:
   |       |-- Fetch that campus's PCO plan (using campus.service_type_id)
   |       |-- Full analysis via Claude -> proposed_changes[] + manual_steps[]
   |       |-- Post separate top-level analysis message for that campus
   |       +-- Save to KV: week:YYYY-MM-DD:CAMPUS_NAME
   |
   +-- Event: message (reply in bot's thread)
   |   |-- Find campus by matching bot_reply_ts across all week:*:* KV entries
   |   |-- Send feedback + current plan to Claude for refinement
   |   |-- Edit bot's Slack message with updated plan
   |   +-- Save updated plan to KV
   |
   +-- Event: reaction_added (checkmark on bot reply)
       |-- Find campus by matching bot_reply_ts across all week:*:* KV entries
       |-- Verify reaction is from campus's configured approver_user_id
       |-- Apply all changes to PCO via API
       |-- Post confirmation reply in thread
       +-- Mark KV entry as applied

2. CRON TRIGGER (Saturday 03:00 UTC = 4 PM NZDT - safety net only)
   |
   |-- Load campuses:CHANNEL_ID
   |-- Check week:YYYY-MM-DD:CAMPUS_NAME for each campus
   |-- If ALL have plan_received = true: do nothing
   +-- If ANY campus is missing a plan: post one generic nudge to channel
```

---

## Message Classification

When any message arrives in the channel, a lightweight Claude call classifies it before
doing any expensive work (no PCO API call yet):

**Prompt:** "Does this Slack message appear to be a weekly church service plan update
that describes what is happening in an upcoming Sunday service, including service
elements, notices, or instructions for the magnification team? Reply with just 'yes' or 'no'."

If 'yes': proceed with full analysis.
If 'no': return immediately, no further action.

This keeps the Worker cheap to run and avoids false triggers from unrelated chat.

---

## Conversational Refinement Loop

After the bot posts its analysis, you can reply in the thread to refine the plan:

```
Bot posts initial analysis:
  "Proposed Changes:
   - [Notice 1] Title -> 'Explaining Christianity'
   - [Preacher] -> 'Pastor Mike'
   Manual Steps: The Slack message mentions a baptism segment - handle manually."

You reply:
  "The baptism item actually goes as a note on the Communion item, not manual."

Bot sends to Claude: current plan + your feedback -> revised plan.

Bot edits its message:
  "Plan updated based on your feedback:
   - [Notice 1] Title -> 'Explaining Christianity'
   - [Preacher] -> 'Pastor Mike'
   - [Communion item] Note added: 'Baptism: [name]'
   React checkmark to apply."

You react checkmark -> changes applied to PCO.
```

The bot uses Slack's `chat.update` to edit its reply in place, keeping the thread clean.
Multiple refinement rounds are supported before checkmark approval.

---

## Cloudflare KV Schema

### Campus config per channel (array, supports multiple campuses)

Key: `campuses:CHANNEL_ID`

Value:
```json
[
  { "campus_name": "North Campus",   "service_type_id": "111", "approver_user_id": "U..." },
  { "campus_name": "Central Campus", "service_type_id": "222", "approver_user_id": "U..." }
]
```

Upserted on every `/plan-setup` submission. Matched by `campus_name` — same name updates, new name appends.

### Weekly state per campus

Key: `week:YYYY-MM-DD:CAMPUS_NAME` (e.g. `week:2026-03-08:North Campus`)

Value:
```json
{
  "plan_received":    true,
  "slack_channel_id": "C...",
  "slack_message_ts": "1741234567.000100",
  "bot_reply_ts":     "1741234999.000200",
  "pco_plan_id":      "12345678",
  "proposed_changes": [...],
  "manual_steps":     [...],
  "applied":          false,
  "campus_name":      "North Campus",
  "service_type_id":  "111",
  "approver_user_id": "U..."
}
```

`campus_name`, `service_type_id`, and `approver_user_id` are denormalized into week state
so that thread replies and reactions can operate without re-fetching campus config.

---

## Automated Rules (deterministic)

These are applied without Claude — they are reliable enough to automate directly:

| Rule | Trigger | Action |
|------|---------|--------|
| Notice title fix | Item titled "Notice 1/2/3", first line of description is real title | Move first line → item title; remove from description |
| Empty notice removal | Some "Notice 1/2/3" items have no description, but others do | Delete the empty ones |
| All notices empty | All of Notice 1, 2, and 3 have no description | Flag as manual step — communications person has likely not filled them in yet |
| Highlight spot removal | Highlight item with no content | Delete item from plan |
| Pray-er placeholder | Item titled "Prayer" has [...] placeholder in its **description** | Lookup "Pray-er" role (upfront team) → replace placeholder in description with volunteer name |
| Bible reading placeholder | Item **description** contains [...] placeholder, item is bible reading | Lookup "Bible Reader" role (upfront team) → replace placeholder in description |
| Sermon placeholder | Item **description** contains [...] placeholder, item is sermon | Lookup "Preacher" role (preaching team) → replace placeholder in description |

---

## Claude's Three Roles

### 1. Classification (cheap — runs on every channel message)
- Input: Slack message text
- Output: `"yes"` or `"no"`
- Max tokens: 10

### 2. Full Analysis (runs once per week when plan is identified)
- Input: Slack message + PCO plan as structured text
- Output:
```json
{
  "proposed_changes": [
    { "type": "notice_title", "item_id": "123", "new_title": "Explaining Christianity", "description_remainder": "..." },
    { "type": "remove_empty_notice", "item_id": "456" },
    { "type": "fill_placeholder", "item_id": "101", "role": "Prayer", "team": "upfront", "volunteer_name": "John Smith" }
  ],
  "manual_steps": [
    "Baptism segment mentioned - unclear where this belongs in the plan."
  ]
}
```

### 3. Refinement (runs on each thread reply from the operator)
- Input: Reply text + current plan from KV + PCO plan context
- Output: Same JSON shape as above, revised based on feedback

---

## PCO API

Base URL: `https://api.planningcenteronline.com/services/v2/`
Auth: HTTP Basic (App ID : Secret)

Key endpoints used:
- `GET /service_types` — find North Campus service type ID
- `GET /service_types/{id}/plans?filter=future` — next Sunday's plan
- `GET /service_types/{id}/plans/{id}/items` — all plan items
- `GET /service_types/{id}/plans/{id}/team_members?include=team` — volunteers + statuses
- `PATCH /service_types/{id}/plans/{id}/items/{id}` — update item title/description
- `DELETE /service_types/{id}/plans/{id}/items/{id}` — remove item

PCO volunteer statuses:
- `confirmed` — accepted the serving request
- `unconfirmed` — request sent, no response yet
- `declined` — has declined

All roles on the plan are checked for roster issues — there is no hardcoded list of watched
roles. Any team member with an unconfirmed or declined status is flagged.

---

## Slack App Requirements

OAuth Scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `chat:write`, `reactions:read`, `reactions:write`

Bot Events subscribed:
- `message.groups` — new messages in private channels
- `reaction_added` — reactions on messages
- `member_joined_channel` — bot join detection

Interactivity & Shortcuts: enabled, same Worker URL

Slash Commands: `/plan-setup`, same Worker URL

The bot must be invited to the private channel manually (`/invite @botname`).

Approval is per-campus — the `approver_user_id` stored in campus config (via `/plan-setup`)
is the only user whose checkmark reaction triggers PCO writes for that campus.

---

## Secrets Reference

| Secret | Description |
|--------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) |
| `SLACK_SIGNING_SECRET` | Used to verify webhook requests came from Slack |
| `SLACK_BOT_USER_ID` | The bot's Slack user ID — used to detect when the bot joins a channel |
| `PCO_APP_ID` | Planning Center Personal Access Token App ID |
| `PCO_SECRET` | Planning Center Personal Access Token Secret |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |

Per-campus settings (`campus_name`, `service_type_id`, `approver_user_id`) are stored
in KV under `campuses:CHANNEL_ID` and configured via `/plan-setup` — not secrets.
