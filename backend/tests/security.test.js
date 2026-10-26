'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { loadConfig, inspectOAuthCredentials } = require('../src/config');
const { createCrypto } = require('../src/crypto');
const { ApprovalStore, argsHash } = require('../src/approvals');
const {
  buildMimeMessage,
  normalizeAddress,
  encodeHeader
} = require('../src/gmailUtil');
const { buildStatus } = require('../src/status');
const { fakeContext } = require('./support');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skassistant-test-'));
}

test('loads read-only scopes by default and write scopes only when enabled', () => {
  const dataDir = tempDir();
  const readConfig = loadConfig({
    rootDir: path.dirname(dataDir),
    env: {
      DATA_DIR: dataDir,
      APP_API_KEY: 'test-key',
      SPREADSHEET_ID: '1UUgd7clBXI1E2sbMbumluES6WAaWnxY8cUpguTfroB8',
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      ENABLE_SHEET_WRITE: 'false',
      ENABLE_GMAIL_WRITE: 'false'
    }
  });
  assert.deepEqual(readConfig.scopes, [
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/gmail.readonly'
  ]);
  assert.equal(readConfig.enableSheetWrite, false);
  assert.equal(readConfig.enableGmailWrite, false);

  const writeConfig = loadConfig({
    rootDir: path.dirname(dataDir),
    env: {
      DATA_DIR: dataDir,
      APP_API_KEY: 'test-key',
      SPREADSHEET_ID: '1UUgd7clBXI1E2sbMbumluES6WAaWnxY8cUpguTfroB8',
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      ENABLE_SHEET_WRITE: 'true',
      ENABLE_GMAIL_WRITE: 'true'
    }
  });
  assert.ok(writeConfig.scopes.includes('https://www.googleapis.com/auth/spreadsheets'));
  assert.ok(writeConfig.scopes.includes('https://www.googleapis.com/auth/gmail.compose'));
  assert.ok(writeConfig.scopes.includes('https://www.googleapis.com/auth/gmail.send'));
});

test('rejects a spreadsheet ID that is not the verified agency spreadsheet', () => {
  assert.throws(
    () =>
      loadConfig({
        env: {
          DATA_DIR: tempDir(),
          APP_API_KEY: 'x',
          SPREADSHEET_ID: 'wrong-spreadsheet-id'
        }
      }),
    /does not match the verified/
  );
});

test('detects Web, Desktop, and service-account credential files without leaking secrets', () => {
  const dir = tempDir();
  const webFile = path.join(dir, 'web.json');
  const desktopFile = path.join(dir, 'desktop.json');
  const serviceFile = path.join(dir, 'service.json');
  fs.writeFileSync(
    webFile,
    JSON.stringify({
      web: {
        client_id: 'web-client-id.apps.googleusercontent.com',
        client_secret: 'web-secret-value',
        redirect_uris: ['https://example.com/oauth/google/callback']
      }
    })
  );
  fs.writeFileSync(
    desktopFile,
    JSON.stringify({
      installed: {
        client_id: 'desktop-client-id.apps.googleusercontent.com',
        client_secret: 'desktop-secret-value',
        redirect_uris: ['http://localhost']
      }
    })
  );
  fs.writeFileSync(
    serviceFile,
    JSON.stringify({
      type: 'service_account',
      client_email: 'service@example.iam.gserviceaccount.com',
      private_key: 'not-a-real-key'
    })
  );

  const base = {
    redirectUri: 'https://backend.example.com/oauth/google/callback',
    googleClientId: '',
    googleClientSecret: ''
  };
  const web = inspectOAuthCredentials(Object.assign({ credentialsFile: webFile }, base));
  assert.equal(web.type, 'web');
  assert.equal(web.compatibleWithBackend, true);
  assert.ok(!JSON.stringify(web).includes('web-secret-value'));

  const desktop = inspectOAuthCredentials(Object.assign({ credentialsFile: desktopFile }, base));
  assert.equal(desktop.type, 'installed');
  assert.equal(desktop.compatibleWithBackend, false);
  assert.match(desktop.message, /Web application OAuth client/);

  const service = inspectOAuthCredentials(Object.assign({ credentialsFile: serviceFile }, base));
  assert.equal(service.type, 'service_account');
  assert.equal(service.compatibleWithBackend, false);
  assert.ok(!JSON.stringify(service).includes('not-a-real-key'));
});

test('encrypts tokens at rest with AES-GCM and rejects tampering', () => {
  const dir = tempDir();
  const config = { dataDir: dir, tokenKeyFile: path.join(dir, 'token.key'), encryptionKey: '' };
  const cryptoBox = createCrypto(config);
  const payload = { access_token: 'a', refresh_token: 'r', scope: 's' };
  const encrypted = cryptoBox.encryptJson(payload);
  assert.ok(!encrypted.includes('refresh_token'));
  assert.deepEqual(cryptoBox.decryptJson(encrypted), payload);
  const parsed = JSON.parse(encrypted);
  parsed.data = Buffer.from('tampered').toString('base64');
  assert.throws(() => cryptoBox.decryptJson(JSON.stringify(parsed)));
  const keyFile = path.join(dir, 'token.key');
  assert.equal(fs.statSync(keyFile).mode & 0o077, 0);
});

test('supports an environment encryption key without writing a key file', () => {
  const dir = tempDir();
  const key = crypto.randomBytes(32).toString('base64');
  const config = { dataDir: dir, tokenKeyFile: path.join(dir, 'token.key'), encryptionKey: key };
  const cryptoBox = createCrypto(config);
  assert.deepEqual(cryptoBox.decryptJson(cryptoBox.encryptJson({ ok: true })), { ok: true });
  assert.equal(fs.existsSync(path.join(dir, 'token.key')), false);
});

test('approval is single-use and binds exact tool arguments', () => {
  const approvals = new ApprovalStore({ approvalTtlSeconds: 300 });
  const args = { to: 'a@example.com', subject: 'Hello', body: 'Body' };
  const created = approvals.create('send_approved_email', args, { title: 'Send email' });
  assert.equal(created.confirmationPhrase, 'SEND');
  assert.throws(() => approvals.approve(created.approvalId, 'APPROVE'), /exactly "SEND"/);
  approvals.approve(created.approvalId, 'SEND');
  assert.throws(
    () => approvals.consume(created.approvalId, 'send_approved_email', Object.assign({}, args, { body: 'Changed' })),
    /does not match/
  );
  approvals.consume(created.approvalId, 'send_approved_email', args);
  assert.throws(
    () => approvals.consume(created.approvalId, 'send_approved_email', args),
    /already been used/
  );
  assert.equal(argsHash('x', { b: 1, a: 2 }), argsHash('x', { a: 2, b: 1 }));
});

test('MIME builder prevents header injection and supports UTF-8', () => {
  assert.throws(() => normalizeAddress('not-an-email'), /Invalid email/);
  const built = buildMimeMessage({
    to: 'Riya <riya@example.com>',
    subject: 'क्रिएटर रेट\r\nBcc: attacker@example.com',
    body: 'नमस्ते, यह एक परीक्षण है।'
  });
  assert.ok(!built.raw.includes('\r\nBcc: attacker@example.com'));
  assert.ok(built.raw.includes('Subject: =?UTF-8?B?'));
  assert.ok(built.rawBase64Url.length > 20);
  assert.equal(encodeHeader('plain subject'), 'plain subject');
});

test('status response excludes OAuth client secrets and tokens', () => {
  const context = fakeContext({
    config: {
      credentials: {
        type: 'web',
        source: 'file',
        compatibleWithBackend: true,
        clientIdSuffix: '...example.com',
        clientSecret: 'super-secret-client-value',
        clientId: 'full-client-id.apps.googleusercontent.com',
        message: 'ok'
      },
      spreadsheetId: '1UUgd7clBXI1E2sbMbumluES6WAaWnxY8cUpguTfroB8',
      requiredSpreadsheetId: '1UUgd7clBXI1E2sbMbumluES6WAaWnxY8cUpguTfroB8',
      scopes: [],
      appDeepLink: 'skassistant://oauth/callback',
      redirectUri: 'https://example.com/oauth/google/callback'
    }
  });
  const status = buildStatus(context, { includeNotes: true });
  const text = JSON.stringify(status);
  assert.ok(!text.includes('super-secret-client-value'));
  assert.ok(!text.includes('fake-access-token'));
  assert.ok(!text.includes('fake-refresh-token'));
  assert.ok(!text.includes('full-client-id.apps.googleusercontent.com'));
  assert.equal(status.oauth.connected, true);
  assert.equal(status.spreadsheet.idMatchesVerifiedId, true);
});
