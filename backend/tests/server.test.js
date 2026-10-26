'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skassistant-server-'));
process.env.DATA_DIR = dataDir;
process.env.APP_API_KEY = 'server-test-key';
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8788';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret-do-not-return';
process.env.ENABLE_SHEET_WRITE = 'false';
process.env.ENABLE_GMAIL_WRITE = 'false';
process.env.DEBUG = 'false';

const { server } = require('../server');

let baseUrl = '';
const authHeaders = {
  Authorization: 'Bearer server-test-key',
  'Content-Type': 'application/json'
};

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('health is public and does not expose secrets', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.authRequired, true);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('test-client-secret-do-not-return'));
  assert.ok(!text.includes('server-test-key'));
});

test('API requires the backend access key', async () => {
  const response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_APP_KEY');
});

test('authenticated status reports blockers honestly', async () => {
  const response = await fetch(`${baseUrl}/api/status`, { headers: authHeaders });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.status.oauth.connected, false);
  assert.equal(body.status.spreadsheet.connected, false);
  assert.equal(body.status.credentials.type, 'environment');
  assert.equal(body.status.writeControls.sheetWritesEnabled, false);
  assert.equal(body.status.writeControls.gmailDraftAndSendEnabled, false);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('test-client-secret-do-not-return'));
  assert.ok(!text.includes('server-test-key'));
});

test('tools list includes availability and requires approval for mutations', async () => {
  const response = await fetch(`${baseUrl}/api/tools`, { headers: authHeaders });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.tools.length >= 20);
  const byName = {};
  for (const tool of body.tools) byName[tool.name] = tool;
  assert.equal(byName.get_spreadsheet_status.available, true);
  assert.equal(byName.search_brands.available, false);
  assert.equal(byName.add_brand.requiresApproval, true);
  assert.equal(byName.send_approved_email.requiresApproval, true);
  assert.equal(byName.create_email_draft.requiresApproval, false);
});

test('OAuth start builds a PKCE authorization URL without exposing the client secret', async () => {
  const response = await fetch(`${baseUrl}/api/oauth/start`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ forceConsent: true })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.oauth.authorizationUrl, /code_challenge=/);
  assert.match(body.oauth.authorizationUrl, /code_challenge_method=S256/);
  assert.match(body.oauth.authorizationUrl, /access_type=offline/);
  assert.match(body.oauth.authorizationUrl, /state=/);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('test-client-secret-do-not-return'));
  assert.ok(!text.includes('code_verifier'));

  const session = await fetch(
    `${baseUrl}/api/oauth/session?state=${encodeURIComponent(body.oauth.state)}`,
    { headers: authHeaders }
  );
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.session.status, 'pending');
});

test('OAuth callback with an unknown state redirects to the app with an error only', async () => {
  const response = await fetch(`${baseUrl}/oauth/google/callback?state=unknown&code=x`, {
    redirect: 'manual'
  });
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(location, /^skassistant:\/\/oauth\/callback\?/);
  assert.match(location, /status=error/);
  assert.ok(!location.includes('code=x'));
});

test('spreadsheet operations without Google authorization return AUTHORIZATION_REQUIRED', async () => {
  const response = await fetch(`${baseUrl}/api/integrations/test/spreadsheet`, {
    method: 'POST',
    headers: authHeaders,
    body: '{}'
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, 'AUTHORIZATION_REQUIRED');
});

test('approval cannot be created for an unavailable write tool', async () => {
  const response = await fetch(`${baseUrl}/api/approvals`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      tool: 'add_brand',
      args: { fields: { brandName: 'Test Brand' } }
    })
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'TOOL_UNAVAILABLE');
});

test('write tools cannot execute without an approval id', async () => {
  const response = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      tool: 'send_approved_email',
      args: { to: 'a@example.com', subject: 'Hello', body: 'Body' }
    })
  });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'APPROVAL_REQUIRED');
});

test('status tool executes and returns an honest disconnected state', async () => {
  const response = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ tool: 'get_spreadsheet_status', args: {} })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.connected, false);
  assert.equal(body.result.spreadsheetId, '1UUgd7clBXI1E2sbMbumluES6WAaWnxY8cUpguTfroB8');
});

test('invalid JSON and unknown routes return structured errors', async () => {
  const invalid = await fetch(`${baseUrl}/api/tools/execute`, {
    method: 'POST',
    headers: authHeaders,
    body: '{bad json'
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_JSON');

  const missing = await fetch(`${baseUrl}/api/nope`, { headers: authHeaders });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'NOT_FOUND');
});
