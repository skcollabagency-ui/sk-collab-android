'use strict';

const https = require('https');
const { URL, URLSearchParams } = require('url');
const crypto = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

class GoogleError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'GoogleError';
    this.status = details && details.status ? details.status : 500;
    this.googleReason = details && details.reason ? details.reason : '';
    this.retryable = this.status === 429 || this.status >= 500;
  }
}

class OAuthRequiredError extends Error {
  constructor(message) {
    super(message || 'Google authorization is required.');
    this.name = 'OAuthRequiredError';
    this.code = 'AUTHORIZATION_REQUIRED';
    this.status = 401;
  }
}

class PermissionRequiredError extends Error {
  constructor(message, scope) {
    super(message);
    this.name = 'PermissionRequiredError';
    this.code = 'PERMISSION_REQUIRED';
    this.status = 403;
    this.scope = scope;
  }
}

function requestText(url, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new GoogleError('Invalid Google API URL.'));
      return;
    }
    const method = opts.method || 'GET';
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    let body = opts.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    if (body !== undefined && body !== null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );
    req.setTimeout(opts.timeoutMs || 30000, () => {
      req.destroy(new GoogleError('Google API request timed out.', { status: 504 }));
    });
    req.on('error', (error) => {
      reject(error instanceof GoogleError ? error : new GoogleError(`Network error: ${error.message}`));
    });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

function parseJson(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text.slice(0, 2000) };
  }
}

function googleErrorFromResponse(label, response) {
  const parsed = parseJson(response.text);
  let message = '';
  let reason = '';
  if (parsed.error && typeof parsed.error === 'object') {
    message = parsed.error.message || '';
    if (Array.isArray(parsed.error.errors) && parsed.error.errors.length) {
      reason = parsed.error.errors[0].reason || '';
    }
    if (!reason && parsed.error.status) reason = parsed.error.status;
  } else if (typeof parsed.error === 'string') {
    message = parsed.error;
  } else if (parsed.error_description) {
    message = parsed.error_description;
  } else if (parsed.raw) {
    message = parsed.raw;
  }
  if (!message) message = `${label} failed with HTTP ${response.status}.`;
  return new GoogleError(message, { status: response.status, reason });
}

function parseScopeString(scope) {
  return String(scope || '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createGoogleClient(config, store) {
  function credentials() {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new OAuthRequiredError(
        'Google OAuth client credentials are not configured on the backend.'
      );
    }
    if (!config.credentials.compatibleWithBackend) {
      throw new OAuthRequiredError(config.credentials.message);
    }
    return {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret
    };
  }

  function buildAuthorizationUrl(options) {
    const opts = options || {};
    const creds = credentials();
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      access_type: 'offline',
      include_granted_scopes: 'true',
      scope: config.scopes.join(' '),
      state: opts.state,
      code_challenge: opts.codeChallenge,
      code_challenge_method: 'S256'
    });
    if (opts.forceConsent) params.set('prompt', 'consent');
    if (opts.loginHint) params.set('login_hint', opts.loginHint);
    return `${AUTH_URL}?${params.toString()}`;
  }

  async function tokenRequest(params) {
    const creds = credentials();
    const form = new URLSearchParams(
      Object.assign(
        {
          client_id: creds.clientId,
          client_secret: creds.clientSecret
        },
        params
      )
    );
    const response = await requestText(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: config.requestTimeoutMs
    });
    const parsed = parseJson(response.text);
    if (response.status < 200 || response.status >= 300) {
      if (parsed.error === 'invalid_grant') {
        store.clearTokens();
        throw new OAuthRequiredError(
          'Google authorization expired or was revoked. Reconnect the Google account.'
        );
      }
      throw googleErrorFromResponse('Google token exchange', response);
    }
    return parsed;
  }

  async function exchangeCode(code, codeVerifier) {
    const tokens = await tokenRequest({
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri
    });
    const previous = store.getTokens() || {};
    const saved = store.setTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || previous.refresh_token || '',
      scope: tokens.scope || previous.scope || '',
      token_type: tokens.token_type,
      expiry_date: Date.now() + Number(tokens.expires_in || 3600) * 1000 - 60000,
      accountEmail: previous.accountEmail || ''
    });
    return saved;
  }

  async function refreshAccessToken() {
    const current = store.getTokens();
    if (!current || !current.refresh_token) {
      throw new OAuthRequiredError('No Google refresh token is available. Reconnect the Google account.');
    }
    const tokens = await tokenRequest({
      refresh_token: current.refresh_token,
      grant_type: 'refresh_token'
    });
    return store.setTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || current.refresh_token,
      scope: tokens.scope || current.scope,
      token_type: tokens.token_type || current.token_type,
      expiry_date: Date.now() + Number(tokens.expires_in || 3600) * 1000 - 60000,
      accountEmail: current.accountEmail
    });
  }

  async function getAccessToken() {
    let tokens = store.getTokens();
    if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
      throw new OAuthRequiredError('Connect an authorized Google account first.');
    }
    if (!tokens.access_token || Number(tokens.expiry_date || 0) <= Date.now() + 30000) {
      tokens = await refreshAccessToken();
    }
    return tokens.access_token;
  }

  function grantedScopes() {
    const tokens = store.getTokens();
    return parseScopeString(tokens && tokens.scope);
  }

  function requireScope(scope, alternatives, purpose) {
    const current = store.getTokens();
    if (!current) {
      throw new OAuthRequiredError('Connect an authorized Google account first.');
    }
    const scopes = grantedScopes();
    const accepted = [scope].concat(alternatives || []);
    if (!accepted.some((item) => scopes.includes(item))) {
      throw new PermissionRequiredError(
        `The Google account has not granted the ${purpose} permission. Requested scope: ${scope}`,
        scope
      );
    }
  }

  async function authorizedRequest(url, options) {
    const opts = Object.assign({}, options || {});
    let accessToken = await getAccessToken();
    opts.headers = Object.assign({}, opts.headers || {}, {
      Authorization: `Bearer ${accessToken}`
    });
    let response = await requestText(url, Object.assign({}, opts, {
      timeoutMs: config.requestTimeoutMs
    }));
    if (response.status === 401) {
      const refreshed = await refreshAccessToken();
      opts.headers.Authorization = `Bearer ${refreshed.access_token}`;
      response = await requestText(url, Object.assign({}, opts, {
        timeoutMs: config.requestTimeoutMs
      }));
    }
    if (response.status < 200 || response.status >= 300) {
      throw googleErrorFromResponse('Google API request', response);
    }
    return parseJson(response.text);
  }

  async function revoke() {
    const tokens = store.getTokens();
    if (tokens && (tokens.refresh_token || tokens.access_token)) {
      const token = tokens.refresh_token || tokens.access_token;
      try {
        await requestText(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: '',
          timeoutMs: config.requestTimeoutMs
        });
      } catch (_) {
        // Local deletion still proceeds even if revocation is unavailable.
      }
    }
    store.clearTokens();
  }

  async function sheetsMetadata() {
    requireScope(
      'https://www.googleapis.com/auth/spreadsheets',
      ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      'Google Sheets read'
    );
    return authorizedRequest(
      `${SHEETS_BASE}/${encodeURIComponent(config.spreadsheetId)}` +
        '?fields=spreadsheetId,properties.title,sheets.properties'
    );
  }

  async function sheetsBatchGet(ranges) {
    requireScope(
      'https://www.googleapis.com/auth/spreadsheets',
      ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      'Google Sheets read'
    );
    if (!Array.isArray(ranges) || ranges.length === 0) return { valueRanges: [] };
    const params = new URLSearchParams();
    for (const range of ranges) params.append('ranges', range);
    params.set('majorDimension', 'ROWS');
    params.set('valueRenderOption', 'FORMATTED_VALUE');
    return authorizedRequest(
      `${SHEETS_BASE}/${encodeURIComponent(config.spreadsheetId)}/values:batchGet?${params.toString()}`
    );
  }

  async function sheetsAppend(range, values) {
    requireScope('https://www.googleapis.com/auth/spreadsheets', [], 'Google Sheets write');
    if (!config.enableSheetWrite) {
      throw new PermissionRequiredError(
        'Google Sheets writes are disabled on the backend. Set ENABLE_SHEET_WRITE=true and grant the write scope.',
        'https://www.googleapis.com/auth/spreadsheets'
      );
    }
    const url =
      `${SHEETS_BASE}/${encodeURIComponent(config.spreadsheetId)}/values/` +
      `${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    return authorizedRequest(url, {
      method: 'POST',
      body: { values }
    });
  }

  async function sheetsBatchUpdate(data) {
    requireScope('https://www.googleapis.com/auth/spreadsheets', [], 'Google Sheets write');
    if (!config.enableSheetWrite) {
      throw new PermissionRequiredError(
        'Google Sheets writes are disabled on the backend. Set ENABLE_SHEET_WRITE=true and grant the write scope.',
        'https://www.googleapis.com/auth/spreadsheets'
      );
    }
    return authorizedRequest(
      `${SHEETS_BASE}/${encodeURIComponent(config.spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        body: { valueInputOption: 'USER_ENTERED', data }
      }
    );
  }

  async function gmailProfile() {
    requireScope(
      'https://www.googleapis.com/auth/gmail.readonly',
      ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'],
      'Gmail read'
    );
    return authorizedRequest(`${GMAIL_BASE}/profile`);
  }

  async function gmailListMessages(query, maxResults) {
    requireScope(
      'https://www.googleapis.com/auth/gmail.readonly',
      ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'],
      'Gmail read'
    );
    const params = new URLSearchParams({
      maxResults: String(Math.max(1, Math.min(Number(maxResults || 20), 50)))
    });
    if (query) params.set('q', query);
    return authorizedRequest(`${GMAIL_BASE}/messages?${params.toString()}`);
  }

  async function gmailGetMessage(id, format) {
    requireScope(
      'https://www.googleapis.com/auth/gmail.readonly',
      ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'],
      'Gmail read'
    );
    const params = new URLSearchParams({
      format: format || 'metadata'
    });
    if (!format || format === 'metadata') {
      for (const header of ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID']) {
        params.append('metadataHeaders', header);
      }
    }
    return authorizedRequest(
      `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?${params.toString()}`
    );
  }

  async function gmailGetThread(id) {
    requireScope(
      'https://www.googleapis.com/auth/gmail.readonly',
      ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.compose'],
      'Gmail read'
    );
    return authorizedRequest(
      `${GMAIL_BASE}/threads/${encodeURIComponent(id)}?format=full`
    );
  }

  async function gmailCreateDraft(rawBase64Url) {
    requireScope('https://www.googleapis.com/auth/gmail.compose', [], 'Gmail draft');
    if (!config.enableGmailWrite) {
      throw new PermissionRequiredError(
        'Gmail draft writes are disabled on the backend. Set ENABLE_GMAIL_WRITE=true and grant the compose scope.',
        'https://www.googleapis.com/auth/gmail.compose'
      );
    }
    return authorizedRequest(`${GMAIL_BASE}/drafts`, {
      method: 'POST',
      body: { message: { raw: rawBase64Url } }
    });
  }

  async function gmailListDrafts(maxResults) {
    requireScope('https://www.googleapis.com/auth/gmail.compose', [], 'Gmail draft');
    const params = new URLSearchParams({
      maxResults: String(Math.max(1, Math.min(Number(maxResults || 20), 50)))
    });
    return authorizedRequest(`${GMAIL_BASE}/drafts?${params.toString()}`);
  }

  async function gmailGetDraft(id) {
    requireScope('https://www.googleapis.com/auth/gmail.compose', [], 'Gmail draft');
    return authorizedRequest(
      `${GMAIL_BASE}/drafts/${encodeURIComponent(id)}?format=full`
    );
  }

  async function gmailSend(rawBase64Url, threadId) {
    requireScope(
      'https://www.googleapis.com/auth/gmail.send',
      ['https://www.googleapis.com/auth/gmail.compose'],
      'Gmail send'
    );
    if (!config.enableGmailWrite) {
      throw new PermissionRequiredError(
        'Gmail sending is disabled on the backend. Set ENABLE_GMAIL_WRITE=true and grant the send scope.',
        'https://www.googleapis.com/auth/gmail.send'
      );
    }
    const body = { raw: rawBase64Url };
    if (threadId) body.threadId = threadId;
    return authorizedRequest(`${GMAIL_BASE}/messages/send`, {
      method: 'POST',
      body
    });
  }

  function makePkce() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  return {
    buildAuthorizationUrl,
    exchangeCode,
    refreshAccessToken,
    getAccessToken,
    grantedScopes,
    requireScope,
    revoke,
    makePkce,
    sheetsMetadata,
    sheetsBatchGet,
    sheetsAppend,
    sheetsBatchUpdate,
    gmailProfile,
    gmailListMessages,
    gmailGetMessage,
    gmailGetThread,
    gmailCreateDraft,
    gmailListDrafts,
    gmailGetDraft,
    gmailSend
  };
}

module.exports = {
  createGoogleClient,
  GoogleError,
  OAuthRequiredError,
  PermissionRequiredError,
  parseScopeString
};
