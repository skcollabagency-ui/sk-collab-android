'use strict';

const {
  gmailConnectionStatus,
  spreadsheetConnectionStatus
} = require('./tools');

function safeCredentialStatus(config) {
  const credentials = config.credentials || {};
  return {
    type: credentials.type || 'none',
    source: credentials.source || 'none',
    compatibleWithBackend: Boolean(credentials.compatibleWithBackend),
    clientIdSuffix: credentials.clientIdSuffix || null,
    message: credentials.message || ''
  };
}

function buildStatus(context, options) {
  const opts = options || {};
  const meta = context.store.getMeta();
  const tokens = context.store.getTokens();
  const gmail = gmailConnectionStatus(context);
  const spreadsheet = spreadsheetConnectionStatus(context);
  const lastError = meta.lastSyncError || meta.gmailLastError || meta.spreadsheetLastError || '';

  return {
    backend: {
      ok: true,
      version: context.config.version,
      now: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime())
    },
    credentials: safeCredentialStatus(context.config),
    oauth: {
      configured: Boolean(context.config.googleClientId && context.config.googleClientSecret),
      connected: Boolean(tokens && (tokens.access_token || tokens.refresh_token)),
      account: gmail.account || meta.gmailEmail || '',
      redirectUri: context.config.redirectUri,
      appDeepLink: context.config.appDeepLink,
      hasRefreshToken: Boolean(tokens && tokens.refresh_token),
      scopesGranted: (tokens && tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : []),
      scopesRequested: context.config.scopes,
      lastRefreshedAt: tokens && tokens.updatedAt ? new Date(tokens.updatedAt).toISOString() : ''
    },
    spreadsheet: Object.assign({}, spreadsheet, {
      idMatchesVerifiedId: context.config.spreadsheetId === context.config.requiredSpreadsheetId,
      id: context.config.spreadsheetId
    }),
    gmail,
    writeControls: {
      sheetWritesEnabled: context.config.enableSheetWrite,
      gmailDraftAndSendEnabled: context.config.enableGmailWrite,
      allMutationsRequireApproval: true,
      sendRequiresTypedConfirmation: true
    },
    ai: {
      backendSummaryConfigured: context.ai.isConfigured(),
      appAiStillRequiredForChat: true
    },
    lastSync: {
      at: meta.lastSyncAt || '',
      error: lastError
    },
    notes: opts.includeNotes
      ? [
          'Google tokens are stored only on the backend and encrypted at rest.',
          'The Android app never receives Google access or refresh tokens.',
          'Spreadsheet writes and email sends require explicit approval and are disabled unless enabled in backend configuration.'
        ]
      : undefined
  };
}

module.exports = { buildStatus, safeCredentialStatus };
