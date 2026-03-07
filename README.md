# mag-weekly-service-plans

Cloudflare Worker that automates the North Campus weekly service plan workflow.

When the service plan is posted in the private Slack channel, the Worker classifies it with Claude, fetches the matching Planning Center plan, proposes changes (notice titles, empty items, placeholder names), and posts an analysis reply in the thread. You can refine it by replying, then react with a checkmark to apply all changes to PCO. A Saturday cron acts as a safety net if no plan has arrived.

---

## Project Structure

```
src/
  worker.js   # Main entry: fetch() + scheduled() handlers
  slack.js    # Slack API helpers (post, edit, verify signatures)
  pco.js      # Planning Center API helpers (fetch plan, apply changes)
  claude.js   # Claude API helpers (classify, analyze, refine)
  utils.js    # Shared date/KV key utilities
wrangler.toml # Cloudflare Worker config (cron, KV binding)
package.json
```

---

## Setup

### 1. Planning Center Online — Personal Access Token

1. Go to [api.planningcenteronline.com/oauth/applications](https://api.planningcenteronline.com/oauth/applications) while logged in
2. Scroll to **Personal Access Tokens** → **+ New Personal Access Token**
3. Name it (e.g. `church-automation`)
4. Copy the **Application ID** → `PCO_APP_ID`
5. Copy the **Secret** → `PCO_SECRET`

> Your PCO account needs access to the **Services** module.

---

### 2. Slack App — Bot Token + Signing Secret

**Create the app**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g. `Service Plan Bot`), select your workspace → **Create App**

**Add OAuth scopes**

3. Left sidebar → **OAuth & Permissions** → **Bot Token Scopes** → **Add an OAuth Scope**
4. Add these three:
   - `groups:history` — read messages in private channels
   - `chat:write` — post and edit messages
   - `reactions:read` — see reactions

**Install to workspace**

5. Scroll up → **Install to Workspace** → **Allow**
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`) → `SLACK_BOT_TOKEN`

**Get the Signing Secret**

7. Left sidebar → **Basic Information** → **App Credentials** → **Signing Secret** → **Show** → `SLACK_SIGNING_SECRET`

**Enable Event Subscriptions** *(after deploying the Worker)*

8. Left sidebar → **Event Subscriptions** → toggle on
9. Paste your Worker URL into **Request URL** (Slack will verify it automatically)
10. Under **Subscribe to bot events** → **Add Bot Event**:
    - `message.groups`
    - `reaction_added`
11. **Save Changes**

**Invite the bot to your channel**

12. In Slack, open `#weekly-service-plans` and type `/invite @Service Plan Bot`

**Find your IDs**

- **Channel ID**: Right-click the channel → **View channel details** → scroll to bottom → `SLACK_CHANNEL_ID`
- **Your user ID**: Click your profile picture → **Profile** → three-dot menu → **Copy member ID** → `APPROVAL_SLACK_USER_ID`

---

### 3. PCO Service Type ID

The Worker needs the ID of the "North" service type inside the NS Mag folder in PCO.
The easiest way to find it:

1. Log in to Planning Center and open Services
2. Navigate to the North service type
3. Look at the URL — it will contain the ID, e.g.:
   `https://services.planningcenteronline.com/service_types/12345678`
4. Copy that number — this is your `NORTH_CAMPUS_SERVICE_TYPE_ID`

If this secret is not set, the Worker will fall back to searching for a service type named "North".

---

### 5. Cloudflare — KV Namespace

```bash
# Log in (opens browser)
npm install -g wrangler
wrangler login

# Create the KV namespace
wrangler kv:namespace create STATE
```

Copy the printed `id` value into `wrangler.toml`, replacing `your-kv-namespace-id`.

---

### 6. Set Secrets & Deploy

```bash
# Set all secrets (each command prompts you to paste the value)
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_CHANNEL_ID
wrangler secret put PCO_APP_ID
wrangler secret put PCO_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put APPROVAL_SLACK_USER_ID
wrangler secret put NORTH_CAMPUS_SERVICE_TYPE_ID

# Deploy
wrangler deploy
```

After deploying, copy the printed `*.workers.dev` URL and paste it into Slack's **Event Subscriptions → Request URL**.

---

## Verification

| Test | Expected |
|------|----------|
| Post a service plan message in the channel | Bot replies in thread with proposed changes |
| Post an unrelated message | Bot silently ignores it |
| Reply to the bot's thread message | Bot edits its reply with refined plan |
| React checkmark to bot's message | PCO updated, confirmation posted in thread |
| `wrangler dev --test-scheduled` (no plan received that week) | Bot posts "has the plan been posted yet?" nudge |
| `wrangler dev --test-scheduled` (plan already received) | Bot does nothing |

---

## NZ Time Zone Note

The cron in `wrangler.toml` is set to `0 3 * * 6` (Saturday 03:00 UTC = 4:00 PM NZDT, UTC+13).
During NZ Standard Time (April–September, UTC+12), change it to `0 4 * * 6`.
