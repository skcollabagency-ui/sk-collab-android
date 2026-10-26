'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AAD = Buffer.from('skassistant-google-tokens-v1', 'utf8');

function decodeKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  try {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === 32) return decoded;
  } catch (_) {
    // Try base64url below.
  }
  try {
    const decoded = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length === 32) return decoded;
  } catch (_) {
    // Ignore and report below.
  }
  throw new Error('TOKEN_ENCRYPTION_KEY must be a 32-byte key encoded as base64, base64url, or 64 hex characters.');
}

function readOrCreateKeyFile(file) {
  if (fs.existsSync(file)) {
    const key = decodeKey(fs.readFileSync(file, 'utf8'));
    if (key) return key;
  }
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key.toString('base64') + '\n', { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {
      // Best effort on restricted Android filesystems.
    }
  } catch (_) {
    // The process can still use the generated in-memory key.
  }
  return key;
}

function createCrypto(config) {
  const key = config.encryptionKey
    ? decodeKey(config.encryptionKey)
    : readOrCreateKeyFile(config.tokenKeyFile);

  function encryptJson(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      v: 1,
      alg: 'A256GCM',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: ciphertext.toString('base64')
    });
  }

  function decryptJson(payload) {
    let parsed;
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (_) {
      throw new Error('Encrypted token payload is not valid JSON.');
    }
    if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.tag || !parsed.data) {
      throw new Error('Encrypted token payload has an unsupported format.');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parsed.iv, 'base64')
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  function hmac(value) {
    return crypto.createHmac('sha256', key).update(String(value)).digest('base64url');
  }

  return { encryptJson, decryptJson, hmac, key };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes || 32).toString('base64url');
}

module.exports = { createCrypto, decodeKey, sha256, randomToken };
