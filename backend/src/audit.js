'use strict';

const fs = require('fs');
const path = require('path');

const SECRET_KEYS = /token|secret|authorization|password|apikey|api_key|code_verifier|cookie/i;
const PRIVATE_KEYS = /^body$|^raw$|^html$|^text$/i;

function redact(value, depth) {
  if (depth > 4) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 240 ? value.slice(0, 240) + '...' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).slice(0, 40)) {
      if (SECRET_KEYS.test(key)) {
        result[key] = '[redacted]';
      } else if (PRIVATE_KEYS.test(key)) {
        result[key] = `[omitted ${String(value[key] || '').length} chars]`;
      } else {
        result[key] = redact(value[key], depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

class AuditLog {
  constructor(config) {
    this.file = path.join(config.dataDir, 'audit.jsonl');
  }

  record(event) {
    const entry = Object.assign(
      { at: new Date().toISOString() },
      event || {}
    );
    entry.details = redact(entry.details, 0);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (_) {
      // Audit failure must not break a request, but it is surfaced through stderr.
      process.stderr.write('audit-write-failed\n');
    }
  }
}

module.exports = { AuditLog, redact };
