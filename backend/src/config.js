'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REQUIRED_SPREADSHEET_ID = '1UUgd7clBXI1E2sbMbumluES6WAaWnxY8cUpguTfroB8';
const APP_DEEP_LINK = 'skassistant://oauth/callback';

const READ_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/gmail.readonly'
];

const SHEET_WRITE_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

function parseEnvFile(file) {
  const result = {};
  if (!fs.existsSync(file)) return result;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readOrCreateSecret(file, bytes) {
  try {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8').trim();
    }
  } catch (_) {
    // Fall through to generation.
  }
  const secret = crypto.randomBytes(bytes).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {
      // chmod is best effort on some Android filesystems.
    }
  } catch (_) {
    // The in-memory secret remains usable for this process.
  }
  return secret;
}

function inspectOAuthCredentials(config) {
  const result = {
    type: 'none',
    source: 'none',
    compatibleWithBackend: false,
    clientIdSuffix: null,
    message: 'No Google OAuth credentials were supplied to the backend.'
  };

  if (config.googleClientId && config.googleClientSecret) {
    result.type = 'environment';
    result.source = 'environment variables GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET';
    result.compatibleWithBackend = true;
    result.clientIdSuffix = lastChars(config.googleClientId, 18);
    result.message =
      'OAuth credentials loaded from environment variables. Confirm they belong to a Web application client.';
    return result;
  }

  if (!config.credentialsFile) {
    result.message =
      'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or GOOGLE_OAUTH_CREDENTIALS to a Web application OAuth client JSON file.';
    return result;
  }

  if (!fs.existsSync(config.credentialsFile)) {
    result.message = `Credential file not found: ${config.credentialsFile}`;
    return result;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8'));
  } catch (_) {
    result.message = 'Credential file exists but is not valid JSON.';
    return result;
  }

  if (parsed.type === 'service_account') {
    result.type = 'service_account';
    result.source = config.credentialsFile;
    result.message =
      'A service account cannot authorize a personal Gmail mailbox through the normal consent flow. Use a Web OAuth client.';
    return result;
  }

  const web = parsed.web;
  if (web && web.client_id && web.client_secret) {
    result.type = 'web';
    result.source = config.credentialsFile;
    result.compatibleWithBackend = true;
    result.clientIdSuffix = lastChars(web.client_id, 18);
    Object.defineProperty(result, 'clientId', { value: web.client_id, enumerable: false });
    Object.defineProperty(result, 'clientSecret', { value: web.client_secret, enumerable: false });
    result.message = 'Google Web application OAuth client detected.';
    return result;
  }

  const installed = parsed.installed;
  if (installed && installed.client_id && installed.client_secret) {
    result.type = 'installed';
    result.source = config.credentialsFile;
    result.clientIdSuffix = lastChars(installed.client_id, 18);
    Object.defineProperty(result, 'clientId', { value: installed.client_id, enumerable: false });
    Object.defineProperty(result, 'clientSecret', { value: installed.client_secret, enumerable: false });
    const redirect = config.redirectUri || '';
    result.compatibleWithBackend =
      redirect.startsWith('http://127.0.0.1') || redirect.startsWith('http://localhost');
    result.message = result.compatibleWithBackend
      ? 'Desktop/installed OAuth client detected. It can only use the configured loopback redirect URI.'
      : 'Desktop/installed OAuth client detected, but a deployed backend callback requires a Web application OAuth client with that HTTPS redirect URI registered.';
    return result;
  }

  result.source = config.credentialsFile;
  result.message = 'Unrecognized OAuth credential JSON. Expected a "web" or "installed" client.';
  return result;
}

function lastChars(value, count) {
  const text = String(value || '');
  if (text.length <= count) return text;
  return '...' + text.slice(-count);
}

function buildScopes(config) {
  const scopes = [READ_SCOPES[0], READ_SCOPES[1]];
  if (config.enableSheetWrite) scopes[0] = SHEET_WRITE_SCOPE;
  if (config.enableGmailWrite) {
    scopes.push(GMAIL_COMPOSE_SCOPE, GMAIL_SEND_SCOPE);
  }
  return scopes;
}

function loadConfig(options) {
  const opts = options || {};
  const rootDir = opts.rootDir || path.join(__dirname, '..');
  const fileEnv = parseEnvFile(path.join(rootDir, '.env'));
  const merged = Object.assign({}, fileEnv, opts.env || {}, process.env);
  const port = Number(merged.PORT || 8787);
  const publicBaseUrl = (merged.PUBLIC_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const spreadsheetId = merged.SPREADSHEET_ID || REQUIRED_SPREADSHEET_ID;
  if (spreadsheetId !== REQUIRED_SPREADSHEET_ID) {
    throw new Error(
      `SPREADSHEET_ID does not match the verified SK Collab Agency spreadsheet (${REQUIRED_SPREADSHEET_ID}).`
    );
  }

  const dataDir = merged.DATA_DIR
    ? path.resolve(merged.DATA_DIR)
    : path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const config = {
    version: '1.0.0',
    rootDir,
    dataDir,
    port,
    host: merged.HOST || '0.0.0.0',
    publicBaseUrl,
    redirectUri: merged.OAUTH_REDIRECT_URI || `${publicBaseUrl}/oauth/google/callback`,
    appDeepLink: APP_DEEP_LINK,
    spreadsheetId,
    requiredSpreadsheetId: REQUIRED_SPREADSHEET_ID,
    googleClientId: merged.GOOGLE_CLIENT_ID || '',
    googleClientSecret: merged.GOOGLE_CLIENT_SECRET || '',
    credentialsFile: merged.GOOGLE_OAUTH_CREDENTIALS
      ? path.resolve(rootDir, merged.GOOGLE_OAUTH_CREDENTIALS)
      : '',
    enableSheetWrite: bool(merged.ENABLE_SHEET_WRITE, false),
    enableGmailWrite: bool(merged.ENABLE_GMAIL_WRITE, false),
    approvalTtlSeconds: Number(merged.APPROVAL_TTL_SECONDS || 300),
    requestTimeoutMs: Number(merged.REQUEST_TIMEOUT_MS || 30000),
    debug: bool(merged.DEBUG, false),
    ai: {
      provider: (merged.AI_PROVIDER || '').toLowerCase(),
      apiKey: merged.AI_API_KEY || '',
      model: merged.AI_MODEL || '',
      baseUrl: merged.AI_BASE_URL || ''
    },
    appApiKey: merged.APP_API_KEY || readOrCreateSecret(
      path.join(dataDir, 'app-api.key'),
      32
    ),
    appApiKeyGenerated: !merged.APP_API_KEY,
    encryptionKey: merged.TOKEN_ENCRYPTION_KEY || '',
    tokenKeyFile: path.join(dataDir, 'token.key')
  };

  config.scopes = buildScopes(config);
  config.credentials = inspectOAuthCredentials(config);
  if (config.credentials.clientId) config.googleClientId = config.credentials.clientId;
  if (config.credentials.clientSecret) config.googleClientSecret = config.credentials.clientSecret;
  return config;
}

module.exports = {
  loadConfig,
  inspectOAuthCredentials,
  parseEnvFile,
  REQUIRED_SPREADSHEET_ID,
  READ_SCOPES,
  SHEET_WRITE_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SEND_SCOPE
};
