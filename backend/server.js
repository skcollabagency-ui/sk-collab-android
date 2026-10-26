'use strict';

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const { loadConfig } = require('./src/config');
const { createCrypto } = require('./src/crypto');
const { Store } = require('./src/store');
const { AuditLog } = require('./src/audit');
const {
  createGoogleClient,
  GoogleError,
  OAuthRequiredError,
  PermissionRequiredError
} = require('./src/google');
const { createWorkbookService } = require('./src/workbook');
const { createAiClient } = require('./src/ai');
const { ApprovalStore } = require('./src/approvals');
const {
  ToolError,
  toolDefinitions,
  listTools,
  previewTool,
  executeTool
} = require('./src/tools');
const { buildStatus } = require('./src/status');
const { createOAuthManager } = require('./src/oauth');

const config = loadConfig();
const tokenCrypto = createCrypto(config);
const store = new Store(config, tokenCrypto);
const audit = new AuditLog(config);
const google = createGoogleClient(config, store);
const workbook = createWorkbookService(config, google, store);
const ai = createAiClient(config);
const approvals = new ApprovalStore(config);
const oauth = createOAuthManager(config, google, store);

const context = { config, store, google, workbook, ai, approvals, audit };
const definitions = {};
for (const definition of toolDefinitions) definitions[definition.name] = definition;

const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return false;
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, 60000).unref();

function securityHeaders(extra) {
  return Object.assign(
    {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    },
    extra || {}
  );
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(
    status,
    securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text)
    })
  );
  res.end(text);
}

function sendRedirect(res, location) {
  res.writeHead(
    302,
    securityHeaders({
      Location: location,
      'Content-Length': '0'
    })
  );
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new ToolError('BODY_TOO_LARGE', 'Request body exceeds 1 MB.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new ToolError('INVALID_JSON', 'Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function timingSafeEqualText(a, b) {
  const first = Buffer.from(String(a || ''));
  const second = Buffer.from(String(b || ''));
  if (first.length !== second.length) return false;
  return crypto.timingSafeEqual(first, second);
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return timingSafeEqualText(match[1], config.appApiKey);
}

function requestIdentity(req) {
  return (
    req.headers['x-forwarded-for'] ||
    (req.socket && req.socket.remoteAddress) ||
    'unknown'
  );
}

function errorResponse(error) {
  if (error instanceof OAuthRequiredError) {
    return {
      status: error.status || 401,
      body: { ok: false, error: { code: 'AUTHORIZATION_REQUIRED', message: error.message } }
    };
  }
  if (error instanceof PermissionRequiredError) {
    return {
      status: error.status || 403,
      body: {
        ok: false,
        error: {
          code: 'PERMISSION_REQUIRED',
          message: error.message,
          details: { scope: error.scope }
        }
      }
    };
  }
  if (error instanceof ToolError) {
    return {
      status: error.status || 400,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details || undefined
        }
      }
    };
  }
  if (error instanceof GoogleError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 502;
    return {
      status,
      body: {
        ok: false,
        error: {
          code: error.googleReason || 'GOOGLE_API_ERROR',
          message: error.message,
          details: config.debug ? { httpStatus: error.status } : undefined
        }
      }
    };
  }
  if (error && error.code === 'BODY_TOO_LARGE') {
    return { status: 413, body: { ok: false, error: { code: error.code, message: error.message } } };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: config.debug ? String(error && error.message) : 'Backend error. Check backend logs.',
        details: config.debug && error ? { stack: String(error.stack).slice(0, 2000) } : undefined
      }
    }
  };
}

function auditTool(name, args, outcome, extra) {
  audit.record({
    event: 'tool',
    tool: name,
    outcome,
    details: Object.assign({ args: args || {} }, extra || {})
  });
}

async function handleToolExecute(req, res) {
  const body = await readBody(req);
  const name = String(body.tool || '');
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  const definition = definitions[name];
  if (!definition) {
    throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
  }
  const identity = requestIdentity(req);
  if (!rateLimit(`tool:${identity}`, 80, 60000)) {
    throw new ToolError('RATE_LIMITED', 'Too many tool requests. Wait a minute and try again.');
  }
  if (name === 'send_approved_email') {
    if (!rateLimit('send:global', 20, 60 * 60 * 1000)) {
      throw new ToolError(
        'SEND_RATE_LIMITED',
        'The email send limit (20 per hour) has been reached. No email was sent.'
      );
    }
  }
  if (name === 'create_email_draft') {
    if (!rateLimit('draft:global', 40, 60 * 60 * 1000)) {
      throw new ToolError(
        'DRAFT_RATE_LIMITED',
        'The draft creation limit (40 per hour) has been reached. No draft was created.'
      );
    }
  }
  if (definition.requiresApproval) {
    if (!body.approvalId) {
      const error = new ToolError(
        'APPROVAL_REQUIRED',
        'This action requires explicit user approval. Create an approval request and show its full preview first.'
      );
      error.status = 403;
      throw error;
    }
    approvals.consume(String(body.approvalId), name, args);
  }
  try {
    const result = await executeTool(context, name, args);
    auditTool(name, args, 'success', { approvalId: body.approvalId || null });
    sendJson(res, 200, {
      ok: true,
      tool: name,
      result,
      executedAt: new Date().toISOString()
    });
  } catch (error) {
    auditTool(name, args, 'error', {
      approvalId: body.approvalId || null,
      errorCode: error.code || error.name,
      errorMessage: error.message
    });
    throw error;
  }
}

async function handleApprovalCreate(req, res) {
  const body = await readBody(req);
  const name = String(body.tool || '');
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  const definition = definitions[name];
  if (!definition) throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
  if (!definition.requiresApproval) {
    throw new ToolError(
      'APPROVAL_NOT_REQUIRED',
      `${name} does not require approval. Execute the tool directly.`
    );
  }
  const preview = await previewTool(context, name, args);
  const approval = approvals.create(name, args, preview, {
    phrase: name === 'send_approved_email' ? 'SEND' : 'APPROVE'
  });
  audit.record({
    event: 'approval-created',
    tool: name,
    outcome: 'pending',
    details: { args, approvalId: approval.approvalId }
  });
  sendJson(res, 200, { ok: true, approval });
}

async function handleApprovalApprove(req, res, approvalId) {
  const body = await readBody(req);
  const result = approvals.approve(approvalId, body.confirmation);
  audit.record({
    event: 'approval-approved',
    tool: result.tool,
    outcome: 'approved',
    details: { approvalId }
  });
  sendJson(res, 200, { ok: true, approval: result });
}

async function handleApprovalCancel(req, res, approvalId) {
  const cancelled = approvals.cancel(approvalId);
  audit.record({
    event: 'approval-cancelled',
    outcome: cancelled ? 'cancelled' : 'not-found',
    details: { approvalId }
  });
  sendJson(res, 200, { ok: true, cancelled });
}

async function testSpreadsheet(req, res) {
  try {
    const data = await workbook.load({ refresh: true });
    const result = {
      ok: true,
      spreadsheetId: data.spreadsheetId,
      spreadsheetTitle: data.title,
      idMatchesVerifiedId: data.spreadsheetId === config.spreadsheetId,
      fetchedAt: data.fetchedAtIso,
      worksheets: data.sheets.map((sheet) => ({
        title: sheet.title,
        role: sheet.role,
        headerRowNumber: sheet.headerRowNumber,
        headers: sheet.headers,
        recordCount: sheet.recordCount,
        sampleRows: sheet.dataRows.slice(0, 2).map((rowInfo) => {
          const values = {};
          sheet.headers.forEach((header, index) => {
            if (!header) return;
            const value = String(rowInfo.values[index] || '').trim();
            if (value) values[header] = value;
          });
          return { rowNumber: rowInfo.rowNumber, values };
        })
      }))
    };
    store.updateMeta({
      spreadsheetLastError: '',
      spreadsheetVerifiedAt: new Date().toISOString()
    });
    audit.record({ event: 'test-spreadsheet', outcome: 'success', details: { title: data.title } });
    sendJson(res, 200, result);
  } catch (error) {
    store.updateMeta({
      spreadsheetLastError: error.message,
      lastSyncError: error.message
    });
    audit.record({
      event: 'test-spreadsheet',
      outcome: 'error',
      details: { errorCode: error.code || error.name, errorMessage: error.message }
    });
    throw error;
  }
}

async function testGmail(req, res) {
  try {
    const profile = await google.gmailProfile();
    let search = null;
    try {
      const listed = await google.gmailListMessages('in:inbox', 1);
      search = {
        resultSizeEstimate: listed.resultSizeEstimate || 0,
        sampleMessageIds: (listed.messages || []).slice(0, 1).map((message) => message.id)
      };
    } catch (_) {
      search = { error: 'Mailbox read test could not run, but the profile was read.' };
    }
    const tokens = store.getTokens() || {};
    store.setTokens(Object.assign({}, tokens, { accountEmail: profile.emailAddress || '' }));
    store.updateMeta({
      gmailEmail: profile.emailAddress || '',
      gmailTestedAt: new Date().toISOString(),
      gmailLastError: ''
    });
    audit.record({
      event: 'test-gmail',
      outcome: 'success',
      details: { account: profile.emailAddress || '' }
    });
    sendJson(res, 200, {
      ok: true,
      account: profile.emailAddress || '',
      messagesTotal: profile.messagesTotal,
      threadsTotal: profile.threadsTotal,
      historyId: profile.historyId,
      capabilities: {
        read: true,
        draft: config.enableGmailWrite && google.grantedScopes().includes('https://www.googleapis.com/auth/gmail.compose'),
        send:
          config.enableGmailWrite &&
          (google.grantedScopes().includes('https://www.googleapis.com/auth/gmail.send') ||
            google.grantedScopes().includes('https://www.googleapis.com/auth/gmail.compose'))
      },
      search
    });
  } catch (error) {
    store.updateMeta({ gmailLastError: error.message, lastSyncError: error.message });
    audit.record({
      event: 'test-gmail',
      outcome: 'error',
      details: { errorCode: error.code || error.name, errorMessage: error.message }
    });
    throw error;
  }
}

async function syncIntegrations(req, res) {
  const result = { spreadsheet: null, gmail: null };
  try {
    const data = await workbook.load({ refresh: true });
    result.spreadsheet = {
      ok: true,
      title: data.title,
      worksheetCount: data.sheets.length,
      fetchedAt: data.fetchedAtIso
    };
  } catch (error) {
    result.spreadsheet = { ok: false, error: error.message, code: error.code || error.name };
    store.updateMeta({ spreadsheetLastError: error.message });
  }
  try {
    const profile = await google.gmailProfile();
    result.gmail = { ok: true, account: profile.emailAddress || '' };
    const tokens = store.getTokens() || {};
    store.setTokens(Object.assign({}, tokens, { accountEmail: profile.emailAddress || '' }));
    store.updateMeta({
      gmailEmail: profile.emailAddress || '',
      gmailTestedAt: new Date().toISOString(),
      gmailLastError: ''
    });
  } catch (error) {
    result.gmail = { ok: false, error: error.message, code: error.code || error.name };
    store.updateMeta({ gmailLastError: error.message });
  }
  const failed = [result.spreadsheet, result.gmail].filter((item) => item && !item.ok);
  const errorText = failed.length
    ? failed.map((item) => `${item.code || 'ERROR'}: ${item.error}`).join(' | ')
    : '';
  store.updateMeta({
    lastSyncAt: new Date().toISOString(),
    lastSyncError: errorText
  });
  audit.record({
    event: 'sync',
    outcome: failed.length ? 'partial' : 'success',
    details: { spreadsheet: result.spreadsheet, gmail: result.gmail }
  });
  sendJson(res, 200, {
    ok: failed.length === 0,
    partial: failed.length > 0 && failed.length < 2,
    result,
    status: buildStatus(context)
  });
}

async function readAudit(req, res, url) {
  const tail = Math.max(1, Math.min(Number(url.searchParams.get('tail') || 50), 200));
  let lines = [];
  try {
    if (fs.existsSync(audit.file)) {
      lines = fs
        .readFileSync(audit.file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-tail)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (_) {
            return { raw: line.slice(0, 200) };
          }
        });
    }
  } catch (_) {
    lines = [];
  }
  sendJson(res, 200, { ok: true, entries: lines });
}

async function route(req, res) {
  const url = new URL(req.url, `${config.publicBaseUrl || 'http://127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'sk-assistant-backend',
      version: config.version,
      now: new Date().toISOString(),
      oauthConfigured: Boolean(config.googleClientId && config.googleClientSecret),
      credentials: {
        type: config.credentials.type,
        compatibleWithBackend: config.credentials.compatibleWithBackend
      },
      spreadsheetId: config.spreadsheetId,
      authRequired: true
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/oauth/google/callback') {
    const result = await oauth.handleCallback(url.searchParams);
    sendRedirect(res, result.redirectUrl);
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, {
      ok: false,
      error: {
        code: 'INVALID_APP_KEY',
        message: 'A valid backend access key is required in the Authorization: Bearer header.'
      }
    });
    return;
  }

  if (!rateLimit(`api:${requestIdentity(req)}`, 240, 60000)) {
    sendJson(res, 429, {
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a minute.' }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, { ok: true, status: buildStatus(context, { includeNotes: true }) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    sendJson(res, 200, {
      ok: true,
      config: {
        spreadsheetId: config.spreadsheetId,
        requiredSpreadsheetId: config.requiredSpreadsheetId,
        publicBaseUrl: config.publicBaseUrl,
        redirectUri: config.redirectUri,
        appDeepLink: config.appDeepLink,
        scopesRequested: config.scopes,
        writeControls: {
          sheetWritesEnabled: config.enableSheetWrite,
          gmailDraftAndSendEnabled: config.enableGmailWrite,
          allMutationsRequireApproval: true
        },
        credentials: {
          type: config.credentials.type,
          compatibleWithBackend: config.credentials.compatibleWithBackend,
          message: config.credentials.message
        }
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    sendJson(res, 200, {
      ok: true,
      tools: listTools(context),
      generatedAt: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tools/execute') {
    await handleToolExecute(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/approvals') {
    await handleApprovalCreate(req, res);
    return;
  }

  const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    await handleApprovalApprove(req, res, decodeURIComponent(approveMatch[1]));
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    await handleApprovalCancel(req, res, decodeURIComponent(cancelMatch[1]));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/oauth/start') {
    const body = await readBody(req);
    const started = oauth.start({
      forceConsent: Boolean(body.forceConsent),
      loginHint: body.loginHint
    });
    audit.record({ event: 'oauth-start', outcome: 'pending', details: { state: started.state } });
    sendJson(res, 200, { ok: true, oauth: started });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/oauth/session') {
    const state = url.searchParams.get('state') || '';
    const session = oauth.getSession(state);
    if (!session) {
      sendJson(res, 404, {
        ok: false,
        error: { code: 'OAUTH_SESSION_NOT_FOUND', message: 'OAuth session not found or expired.' }
      });
      return;
    }
    sendJson(res, 200, { ok: true, session });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/oauth/disconnect') {
    await google.revoke();
    workbook.invalidate();
    store.updateMeta({
      gmailEmail: '',
      oauthDisconnectedAt: new Date().toISOString(),
      lastSyncError: ''
    });
    audit.record({ event: 'oauth-disconnect', outcome: 'success', details: {} });
    sendJson(res, 200, { ok: true, disconnected: true, status: buildStatus(context) });
    return;
  }

  if (
    (req.method === 'POST' || req.method === 'GET') &&
    url.pathname === '/api/integrations/test/spreadsheet'
  ) {
    await testSpreadsheet(req, res);
    return;
  }

  if (
    (req.method === 'POST' || req.method === 'GET') &&
    url.pathname === '/api/integrations/test/gmail'
  ) {
    await testGmail(req, res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/integrations/sync') {
    await syncIntegrations(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    await readAudit(req, res, url);
    return;
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const mapped = errorResponse(error);
    if (config.debug) {
      process.stderr.write(`request-error ${error && error.name}: ${error && error.message}\n`);
    }
    if (!res.headersSent) sendJson(res, mapped.status, mapped.body);
    else res.end();
  });
});

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `SK Assistant backend listening on http://${config.host}:${config.port}\n`
    );
    process.stdout.write(`Public base URL: ${config.publicBaseUrl}\n`);
    process.stdout.write(`Spreadsheet ID: ${config.spreadsheetId}\n`);
    process.stdout.write(
      `Google OAuth credentials: ${config.credentials.type} ` +
        `(backend compatible: ${config.credentials.compatibleWithBackend})\n`
    );
    if (!config.credentials.compatibleWithBackend) {
      process.stdout.write(`OAuth blocker: ${config.credentials.message}\n`);
    }
    process.stdout.write(
      `App access key source: ${config.appApiKeyGenerated ? path.join(config.dataDir, 'app-api.key') : 'APP_API_KEY environment variable'}\n`
    );
    process.stdout.write(
      `Writes: sheets=${config.enableSheetWrite}, gmail=${config.enableGmailWrite}, approvals=required\n`
    );
    if (!ai.isConfigured()) {
      process.stdout.write('Backend AI summarizer: not configured (app AI can summarize tool output).\n');
    }
  });
}

module.exports = { server, context, config };
