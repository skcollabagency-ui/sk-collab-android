'use strict';

const fs = require('fs');
const path = require('path');

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    // Best effort.
  }
}

class Store {
  constructor(config, crypto) {
    this.config = config;
    this.crypto = crypto;
    this.tokensFile = path.join(config.dataDir, 'google-tokens.enc');
    this.metaFile = path.join(config.dataDir, 'meta.json');
    this.sentIndexFile = path.join(config.dataDir, 'sent-index.json');
  }

  getTokens() {
    if (!fs.existsSync(this.tokensFile)) return null;
    try {
      const encrypted = fs.readFileSync(this.tokensFile, 'utf8');
      return this.crypto.decryptJson(encrypted);
    } catch (error) {
      throw new Error(`Stored Google tokens could not be decrypted: ${error.message}`);
    }
  }

  setTokens(tokens) {
    const safe = {
      access_token: tokens.access_token || '',
      refresh_token: tokens.refresh_token || '',
      scope: tokens.scope || '',
      token_type: tokens.token_type || 'Bearer',
      expiry_date: tokens.expiry_date || 0,
      accountEmail: tokens.accountEmail || '',
      updatedAt: Date.now()
    };
    atomicWrite(this.tokensFile, this.crypto.encryptJson(safe));
    return safe;
  }

  clearTokens() {
    try {
      if (fs.existsSync(this.tokensFile)) fs.unlinkSync(this.tokensFile);
    } catch (_) {
      // Ignore.
    }
  }

  getMeta() {
    return safeReadJson(this.metaFile, {});
  }

  updateMeta(patch) {
    const meta = Object.assign(this.getMeta(), patch || {});
    atomicWrite(this.metaFile, JSON.stringify(meta, null, 2));
    return meta;
  }

  getSentRecord(hash) {
    const index = safeReadJson(this.sentIndexFile, {});
    return index[hash] || null;
  }

  setSentRecord(hash, record) {
    const index = safeReadJson(this.sentIndexFile, {});
    index[hash] = Object.assign({ sentAt: Date.now() }, record || {});
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (const key of Object.keys(index)) {
      if (!index[key] || !index[key].sentAt || index[key].sentAt < cutoff) delete index[key];
    }
    atomicWrite(this.sentIndexFile, JSON.stringify(index, null, 2));
  }
}

module.exports = { Store, atomicWrite, safeReadJson };
