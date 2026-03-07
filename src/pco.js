/**
 * pco.js - Planning Center Online API helpers
 *
 * Base URL: https://api.planningcenteronline.com/services/v2/
 * Auth:     HTTP Basic (App ID : Secret)
 */

const PCO_BASE = 'https://api.planningcenteronline.com/services/v2';

// ─────────────────────────────────────────────
// MAIN: Fetch next Sunday's North Campus plan
// ─────────────────────────────────────────────

/**
 * Returns a structured plan object:
 * {
 *   id, title, sort_date,
 *   items: [ { id, title, description, item_type, sequence, ... } ],
 *   teams: [ { id, name, members: [ { id, name, role, status } ] } ],
 *   roster_issues: [ "Worship Leader: no one scheduled", ... ]
 * }
 */
export async function fetchNextSundayPlan(appId, secret) {
  // 1. Find North Campus service type
  const serviceTypeId = await findNorthCampusServiceTypeId(appId, secret);

  // 2. Get the next upcoming plan
  const plan = await getNextPlan(serviceTypeId, appId, secret);

  // 3. Get items
  const items = await getAllPages(`${PCO_BASE}/service_types/${serviceTypeId}/plans/${plan.id}/items?include=item_notes&per_page=100`, appId, secret);

  // 4. Get teams and their members
  const teams = await getPlanTeams(plan.id, serviceTypeId, appId, secret);

  // 5. Analyse roster for issues
  const roster_issues = buildRosterIssues(teams);

  return {
    id: plan.id,
    title: plan.attributes.title,
    sort_date: plan.attributes.sort_date,
    items,
    teams,
    roster_issues,
  };
}

// ─────────────────────────────────────────────
// APPLY CHANGES
// ─────────────────────────────────────────────

/**
 * Apply an array of proposed_changes to PCO.
 * Returns an array of result objects: { ok, description, error? }
 */
export async function applyChangesToPco(planId, proposedChanges, appId, secret) {
  const results = [];

  for (const change of proposedChanges) {
    try {
      await applyChange(planId, change, appId, secret);
      results.push({ ok: true, description: describeChange(change) });
    } catch (err) {
      results.push({ ok: false, description: describeChange(change), error: err.message });
    }
  }

  return results;
}

async function applyChange(planId, change, appId, secret) {
  switch (change.type) {
    case 'notice_title': {
      await pcoRequest(
        'PATCH',
        `/service_types/0/plans/${planId}/items/${change.item_id}`,
        {
          data: {
            type: 'Item',
            attributes: {
              title: change.new_title,
              description: change.description_remainder ?? '',
            },
          },
        },
        appId,
        secret,
      );
      break;
    }

    case 'remove_empty_notice':
    case 'remove_empty_highlight': {
      await pcoRequest(
        'DELETE',
        `/service_types/0/plans/${planId}/items/${change.item_id}`,
        null,
        appId,
        secret,
      );
      break;
    }

    case 'fill_placeholder': {
      await pcoRequest(
        'PATCH',
        `/service_types/0/plans/${planId}/items/${change.item_id}`,
        {
          data: {
            type: 'Item',
            attributes: { description: change.new_description },
          },
        },
        appId,
        secret,
      );
      break;
    }

    default:
      throw new Error(`Unknown change type: ${change.type}`);
  }
}

function describeChange(change) {
  switch (change.type) {
    case 'notice_title':      return `Title updated for item ${change.item_id} → "${change.new_title}"`;
    case 'remove_empty_notice':  return `Deleted empty notice item ${change.item_id}`;
    case 'remove_empty_highlight': return `Deleted empty highlight item ${change.item_id}`;
    case 'fill_placeholder':  return `Filled placeholder in item ${change.item_id} → "${change.volunteer_name}"`;
    default:                  return JSON.stringify(change);
  }
}

// ─────────────────────────────────────────────
// SERVICE TYPE LOOKUP
// ─────────────────────────────────────────────

async function findNorthCampusServiceTypeId(appId, secret) {
  const data = await getAllPages(`${PCO_BASE}/service_types?per_page=100`, appId, secret);
  const nc = data.find((st) =>
    st.attributes.name?.toLowerCase().includes('north campus'),
  );
  if (!nc) {
    throw new Error('Could not find a North Campus service type in PCO');
  }
  return nc.id;
}

// ─────────────────────────────────────────────
// PLAN LOOKUP
// ─────────────────────────────────────────────

async function getNextPlan(serviceTypeId, appId, secret) {
  const data = await getAllPages(
    `${PCO_BASE}/service_types/${serviceTypeId}/plans?filter=future&order=sort_date&per_page=5`,
    appId,
    secret,
  );
  if (data.length === 0) {
    throw new Error('No upcoming plans found in PCO for North Campus');
  }
  // Return the soonest future plan
  return data[0];
}

// ─────────────────────────────────────────────
// TEAMS & ROSTER
// ─────────────────────────────────────────────

async function getPlanTeams(planId, serviceTypeId, appId, secret) {
  // Get teams attached to this plan
  const planTeams = await getAllPages(
    `${PCO_BASE}/service_types/${serviceTypeId}/plans/${planId}/team_members?include=team&per_page=100`,
    appId,
    secret,
  );

  // Group by team
  const teamMap = {};
  for (const member of planTeams) {
    const teamId = member.relationships?.team?.data?.id ?? 'unknown';
    const teamName = member.relationships?.team?.data?.attributes?.name ?? teamId;
    if (!teamMap[teamId]) {
      teamMap[teamId] = { id: teamId, name: teamName, members: [] };
    }
    teamMap[teamId].members.push({
      id: member.id,
      name: member.attributes.name,
      role: member.attributes.team_position_name,
      status: member.attributes.status, // confirmed | unconfirmed | declined
    });
  }

  return Object.values(teamMap);
}

function buildRosterIssues(teams) {
  const issues = [];
  const watchedRoles = [
    'Worship Leader',
    'Sound Tech',
    'Slides Operator',
    'Magnification',
    'Kids Ministry',
    'Bible Reader',
    'Preacher',
    'Prayer',
  ];

  for (const team of teams) {
    for (const member of team.members) {
      if (!watchedRoles.includes(member.role)) continue;
      if (member.status === 'unconfirmed') {
        issues.push(`${member.role}: ${member.name} has not yet responded to the serving request`);
      } else if (member.status === 'declined') {
        issues.push(`${member.role}: ${member.name} has declined`);
      }
    }

    // Check for completely unfilled watched roles
    for (const role of watchedRoles) {
      const hasAny = team.members.some((m) => m.role === role);
      if (!hasAny) {
        // Only flag if the team name suggests it's relevant
        if (
          role === 'Worship Leader' ||
          role === 'Sound Tech' ||
          role === 'Preacher'
        ) {
          issues.push(`${role}: no one scheduled`);
        }
      }
    }
  }

  return issues;
}

// ─────────────────────────────────────────────
// PCO HTTP HELPERS
// ─────────────────────────────────────────────

/**
 * Follow PCO pagination and return all data[] items.
 */
async function getAllPages(url, appId, secret) {
  const all = [];
  let nextUrl = url;

  while (nextUrl) {
    const res = await pcoFetch('GET', nextUrl, null, appId, secret);
    all.push(...(res.data ?? []));
    nextUrl = res.links?.next ?? null;
  }

  return all;
}

async function pcoRequest(method, path, body, appId, secret) {
  return pcoFetch(method, `${PCO_BASE}${path}`, body, appId, secret);
}

async function pcoFetch(method, url, body, appId, secret) {
  const headers = {
    Authorization: `Basic ${btoa(`${appId}:${secret}`)}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return {}; // DELETE success

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.errors?.[0]?.detail ?? res.statusText;
    throw new Error(`PCO API error ${res.status} on ${method} ${url}: ${msg}`);
  }

  return data;
}
