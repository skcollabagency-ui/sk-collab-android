'use strict';

const crypto = require('crypto');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

function argsHash(tool, args) {
  return crypto
    .createHash('sha256')
    .update(tool + '\n' + JSON.stringify(stableValue(args || {})))
    .digest('hex');
}

class ApprovalStore {
  constructor(config) {
    this.ttlMs = Math.max(30, Number(config.approvalTtlSeconds || 300)) * 1000;
    this.items = new Map();
  }

  cleanup() {
    const now = Date.now();
    for (const [id, item] of this.items) {
      if (item.expiresAt <= now) this.items.delete(id);
    }
  }

  create(tool, args, preview, options) {
    this.cleanup();
    const id = crypto.randomBytes(24).toString('base64url');
    const opts = options || {};
    const phrase = opts.phrase || (tool === 'send_approved_email' ? 'SEND' : 'APPROVE');
    const item = {
      id,
      tool,
      args: args || {},
      hash: argsHash(tool, args || {}),
      preview: preview || {},
      phrase,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      approvedAt: 0,
      usedAt: 0
    };
    this.items.set(id, item);
    return publicView(item);
  }

  get(id) {
    this.cleanup();
    return this.items.get(id) || null;
  }

  approve(id, phrase) {
    this.cleanup();
    const item = this.items.get(id);
    if (!item) throw new Error('Approval request was not found or has expired.');
    if (item.usedAt) throw new Error('Approval has already been used.');
    if (item.expiresAt <= Date.now()) throw new Error('Approval request has expired.');
    if (String(phrase || '').trim() !== item.phrase) {
      throw new Error(`Confirmation phrase must be exactly "${item.phrase}".`);
    }
    item.approvedAt = Date.now();
    return publicView(item);
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item) return false;
    item.usedAt = Date.now();
    this.items.delete(id);
    return true;
  }

  consume(id, tool, args) {
    this.cleanup();
    const item = this.items.get(id);
    if (!item) throw new Error('Approval request was not found or has expired.');
    if (!item.approvedAt) throw new Error('Approval has not been granted.');
    if (item.usedAt) throw new Error('Approval has already been used.');
    if (item.expiresAt <= Date.now()) throw new Error('Approval request has expired.');
    if (item.tool !== tool) throw new Error('Approval does not match the requested tool.');
    if (item.hash !== argsHash(tool, args || {})) {
      throw new Error('Approval does not match the requested arguments.');
    }
    item.usedAt = Date.now();
    return item;
  }
}

function publicView(item) {
  return {
    approvalId: item.id,
    tool: item.tool,
    argsHash: item.hash,
    preview: item.preview,
    confirmationPhrase: item.phrase,
    expiresAt: new Date(item.expiresAt).toISOString(),
    approved: Boolean(item.approvedAt),
    used: Boolean(item.usedAt)
  };
}

module.exports = { ApprovalStore, argsHash };
