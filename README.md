# mag-weekly-service-plans

Cloudflare Worker that automates the weekly service plan workflow for one or more campuses sharing a single Slack channel.

When the service plan is posted in the channel, the Worker classifies it with Claude, then for each configured campus fetches the matching Planning Center plan, proposes changes (notice titles, empty items, placeholder names), and posts a separate analysis message. You can refine a campus's plan by replying in its thread, then react with a checkmark to apply changes to PCO. A Saturday cron nudges the channel if any campus hasn't received a plan yet.

Campuses are configured via `/plan-setup` — no secrets required for per-campus settings.

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

**Enable Interactivity** *(after deploying the Worker)*

8. Left sidebar → **Interactivity & Shortcuts** → toggle on
9. Paste your Worker URL into **Request URL** → **Save Changes**

**Add slash command**

10. Left sidebar → **Slash Commands** → **Create New Command**
11. Command: `/plan-setup`, Request URL: your Worker URL, Short description: `Configure a campus`
12. **Save**

**Enable Event Subscriptions** *(after deploying the Worker)*

13. Left sidebar → **Event Subscriptions** → toggle on
14. Paste your Worker URL into **Request URL** (Slack will verify it automatically)
15. Under **Subscribe to bot events** → **Add Bot Event**:
    - `message.groups`
    - `reaction_added`
    - `member_joined_channel`
16. **Save Changes**

**Invite the bot to your channel**

17. In Slack, open `#weekly-service-plans` and type `/invite @Service Plan Bot`
    - The bot will post an ephemeral message prompting you to run `/plan-setup`

**Find your IDs**

- **Channel ID**: Right-click the channel → **View channel details** → scroll to bottom → `SLACK_CHANNEL_ID`
- **Bot User ID**: In Slack, open the bot's profile → three-dot menu → **Copy member ID** → `SLACK_BOT_USER_ID`

---

### 3. Cloudflare — KV Namespace

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **KV**
2. Click **Create a namespace** (the name doesn't matter) → **Add**
3. Copy the namespace ID and paste it into `wrangler.toml`, replacing `your-kv-namespace-id`
4. Commit and push — the GitHub Actions deploy will pick it up

---

### 4. Deploy via GitHub Actions

Deployment runs automatically on every push to `main`. For the first deploy:

1. Go to the repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
2. Add a secret named `CLOUDFLARE_API_TOKEN` — create one at **Cloudflare dashboard → My Profile → API Tokens** with the **Edit Cloudflare Workers** template
3. Push any change to `main` to trigger the first deploy

**After the first deploy**, your Worker URL (`*.workers.dev`) will appear in the GitHub Actions log. Paste it into:
- Slack app → **Interactivity & Shortcuts → Request URL**
- Slack app → **Slash Commands → `/plan-setup` → Request URL**
- Slack app → **Event Subscriptions → Request URL**

### 5. Set Worker Secrets

Worker secrets are set in the Cloudflare dashboard — not via wrangler CLI.

1. Go to **Cloudflare dashboard → Workers & Pages** → click your worker → **Settings** → **Variables**
2. Under **Environment Variables**, add each of the following as an **encrypted** variable:

| Secret | Value |
|--------|-------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | From Slack app → Basic Information → App Credentials |
| `SLACK_CHANNEL_ID` | ID of the private channel the bot is in |
| `SLACK_BOT_USER_ID` | Bot's Slack user ID |
| `PCO_APP_ID` | Planning Center Personal Access Token App ID |
| `PCO_SECRET` | Planning Center Personal Access Token Secret |
| `ANTHROPIC_API_KEY` | Anthropic API key |

---

### 5. Configure Campuses via Slack

Campus config (name, PCO service type ID, approver) is stored in KV — not in secrets.

In the Slack channel, run `/plan-setup` and fill in the modal:
- **Campus Name** — e.g. `North Campus`
- **PCO Service Type ID** — the number from the PCO URL (e.g. `12345678`)
- **Approver** — the person whose checkmark reaction triggers PCO writes

Run `/plan-setup` again with a different campus name to add another campus. Re-run with the same name to update an existing campus.

---

## Verification

| Test | Expected |
|------|----------|
| Run `/plan-setup` with a campus name | Modal appears; on submit, ephemeral "X configured." appears |
| Run `/plan-setup` again with same campus name | Config updated (not duplicated) |
| Run `/plan-setup` with a different campus name | Second campus added to KV |
| Invite bot to channel (bot itself joins) | Ephemeral prompt to run `/plan-setup` (only if no campuses configured yet) |
| Post a service plan message | Bot posts one analysis message per configured campus |
| Post an unrelated message | Bot silently ignores it |
| Reply to a campus's bot thread message | Bot edits that campus's reply with refined plan |
| React checkmark to a campus's bot message | PCO updated for that campus, confirmation posted in thread |
| Saturday cron fires (at least one campus has no plan) | Bot posts one generic nudge |
| Saturday cron fires (all campuses have received plans) | Bot does nothing |

---

## NZ Time Zone Note

The cron in `wrangler.toml` is set to `0 3 * * 6` (Saturday 03:00 UTC = 4:00 PM NZDT, UTC+13).
During NZ Standard Time (April–September, UTC+12), change it to `0 4 * * 6`.
