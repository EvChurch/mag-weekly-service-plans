# Offline verification

Run `npm ci`, `npm run check`, `npm test`, and `npm run build:check`.
The Node test runner verifies Slack HMAC rejection/acceptance, the HTTP handshake,
and Auckland calendar/campus keys without calling Slack, PCO, Anthropic or KV.
Wrangler dry-run bundles the actual Worker; it does not deploy or require credentials.
CI runs on pull requests (including forks) and main pushes with read-only permissions.
The existing deploy workflow is unchanged. Real service integration and approval-driven
PCO writes remain outside this offline suite. No dependency or lockfile change is needed.
