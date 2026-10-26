'use strict';

const { randomToken } = require('./crypto');

function createOAuthManager(config, google, store) {
  const sessions = new Map();
  const ttlMs = 10 * 60 * 1000;

  function cleanup() {
    const now = Date.now();
    for (const [state, session] of sessions) {
      if (session.createdAt + ttlMs < now) sessions.delete(state);
    }
  }

  function start(options) {
    cleanup();
    const opts = options || {};
    const state = randomToken(32);
    const pkce = google.makePkce();
    const authorizationUrl = google.buildAuthorizationUrl({
      state,
      codeChallenge: pkce.challenge,
      forceConsent: Boolean(opts.forceConsent),
      loginHint: opts.loginHint
    });
    sessions.set(state, {
      state,
      verifier: pkce.verifier,
      createdAt: Date.now(),
      status: 'pending',
      message: '',
      account: ''
    });
    return {
      authorizationUrl,
      state,
      redirectUri: config.redirectUri,
      appDeepLink: config.appDeepLink,
      expiresAt: new Date(Date.now() + ttlMs).toISOString()
    };
  }

  function getSession(state) {
    cleanup();
    const session = sessions.get(state);
    if (!session) return null;
    return {
      state: session.state,
      status: session.status,
      message: session.message,
      account: session.account,
      createdAt: new Date(session.createdAt).toISOString()
    };
  }

  function deepLink(status, state, message) {
    const params = new URLSearchParams({ status, state });
    if (message) params.set('message', String(message).slice(0, 300));
    return `${config.appDeepLink}?${params.toString()}`;
  }

  async function handleCallback(queryParams) {
    const state = queryParams.get('state') || '';
    const session = sessions.get(state);
    if (!session) {
      return { redirectUrl: deepLink('error', state, 'OAuth session not found or expired.') };
    }
    if (session.status === 'success') {
      return { redirectUrl: deepLink('success', state, 'Already connected.') };
    }
    const oauthError = queryParams.get('error');
    if (oauthError) {
      session.status = 'error';
      session.message = queryParams.get('error_description') || oauthError;
      return { redirectUrl: deepLink('error', state, session.message) };
    }
    const code = queryParams.get('code');
    if (!code) {
      session.status = 'error';
      session.message = 'Authorization code was not returned by Google.';
      return { redirectUrl: deepLink('error', state, session.message) };
    }
    try {
      await google.exchangeCode(code, session.verifier);
      let account = '';
      try {
        const profile = await google.gmailProfile();
        account = profile.emailAddress || '';
        if (account) {
          const current = store.getTokens() || {};
          store.setTokens(Object.assign({}, current, { accountEmail: account }));
          store.updateMeta({
            gmailEmail: account,
            gmailTestedAt: new Date().toISOString(),
            gmailLastError: ''
          });
        }
      } catch (profileError) {
        session.message =
          `Authorization succeeded, but the Gmail profile could not be verified: ${profileError.message}`;
      }
      session.account = account;
      session.status = 'success';
      if (!session.message) session.message = 'Google account connected.';
      store.updateMeta({ lastSyncError: '', oauthConnectedAt: new Date().toISOString() });
      return { redirectUrl: deepLink('success', state, session.message) };
    } catch (error) {
      session.status = 'error';
      session.message = error.message;
      store.updateMeta({ lastSyncError: error.message });
      return { redirectUrl: deepLink('error', state, error.message) };
    }
  }

  return { start, getSession, handleCallback };
}

module.exports = { createOAuthManager };
