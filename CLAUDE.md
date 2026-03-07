# CLAUDE.md — Architecture & Design Reference

This file describes the original architecture plan for this project so that Claude
can understand the intent and design decisions when making future changes.

---

## What This Project Does

This is a Cloudflare Worker that automates the North Campus weekly service plan workflow.
The operator (magnification driver) previously had to manually read the service plan
posted in a private Slack channel, cross-reference it against the Planning Center Online
(PCO) plan, fix recurring issues (notice titles, placeholder names, empty items), and
check volunteer roster gaps. This project automates all of that.

---

## Architecture: Event-Driven + Safety Net Cron

All logic runs in a single Cloudflare Worker with two entry points:

```
1. HTTP HANDLER (receives all Slack Events API webhooks)
   |
   +-- Event: message.groups (new message in #weekly-service-plans)
   |   |
   |   |-- [Classification] Send message to Claude:
   |   |   "Is this the weekly North Campus service plan update?"
   |   |   -> yes / no
   |   |
   |   |-- If NO: ignore and return
   |   |
   |   +-- If YES:
   |       |-- Fetch next Sunday North Campus plan from PCO API
   |       |       (includes items, teams, and all team member statuses)
   |       |-- Check all team positions for scheduling gaps (no-reply, declined, unfilled)
   |       |-- Send Slack message + PCO plan to Claude for full analysis
   |       |   -> proposed_changes[] + manual_steps[]
   |       |-- Save plan to Cloudflare KV (key = week date, plan_received = true)
   |       +-- Post Slack reply to that message's thread
   |           (includes: Proposed Changes, Roster Check, Manual Steps)
   |
   +-- Event: message (reply in bot's thread)
   |   |-- Detect it's a reply to the bot's message
   |   |-- Send feedback + current plan to Claude for refinement
   |   |-- Edit bot's Slack message with updated plan
   |   +-- Save updated plan to KV
   |
   +-- Event: reaction_added (checkmark on bot reply)
       |-- Verify it's the approved user's checkmark on the bot's message
       |-- Load plan from KV
       |-- Apply all changes to PCO via API
       |-- Post confirmation reply in thread
       +-- Mark KV entry as applied

2. CRON TRIGGER (Saturday 03:00 UTC = 4 PM NZDT - safety net only)
   |
   |-- Check KV for this week: has plan_received = true?
   |-- If YES: do nothing (plan already processed)
   +-- If NO: post to channel:
       "Hey, just checking - has the service plan for this Sunday been posted yet?
        I haven't seen it come through."
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

Key: `week:YYYY-MM-DD` (the Sunday date of that week's service)

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
  "applied":          false
}
```

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

OAuth Scopes: `groups:history`, `chat:write`, `reactions:read`

Bot Events subscribed:
- `message.groups` — new messages in private channels
- `reaction_added` — reactions on messages

The bot must be invited to the private channel manually (`/invite @botname`).

Approval is gated on `APPROVAL_SLACK_USER_ID` — only reactions from that user trigger PCO writes.

---

## Secrets Reference

| Secret | Description |
|--------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (xoxb-...) |
| `SLACK_SIGNING_SECRET` | Used to verify webhook requests came from Slack |
| `SLACK_CHANNEL_ID` | ID of the #weekly-service-plans private channel |
| `PCO_APP_ID` | Planning Center Personal Access Token App ID |
| `PCO_SECRET` | Planning Center Personal Access Token Secret |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |
| `APPROVAL_SLACK_USER_ID` | Your Slack user ID — only your checkmark triggers PCO writes |
| `CAMPUS_NAME` | Display name shown in thread replies (e.g. "North Campus"). Useful when multiple workers share a channel. |
| `SERVICE_TYPE_ID` | PCO service type ID. Found in the URL when viewing the service type in PCO. |
