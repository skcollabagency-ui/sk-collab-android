'use strict';

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

function stripCrLf(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value) {
  const text = stripCrLf(value);
  if (!text) return '';
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function normalizeAddress(value) {
  const text = stripCrLf(value);
  if (!text) throw new Error('Email address is empty.');
  const angle = text.match(/^(.*?)<([^<>]+)>$/);
  let display = '';
  let email = '';
  if (angle) {
    display = angle[1].trim().replace(/^["']|["']$/g, '');
    email = angle[2].trim();
  } else {
    email = text;
  }
  if (!EMAIL_RE.test(email)) {
    throw new Error(`Invalid email address: ${email}`);
  }
  if (display) {
    if (display.length > 120) throw new Error('Email display name is too long.');
    return `"${display.replace(/["\\]/g, '')}" <${email}>`;
  }
  return email;
}

function normalizeAddressList(value, maxCount) {
  const parts = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!parts.length) return [];
  if (parts.length > (maxCount || 5)) {
    throw new Error(`Too many email recipients (maximum ${maxCount || 5}).`);
  }
  return parts.map(normalizeAddress);
}

function wrapBase64(text, lineLength) {
  const width = lineLength || 76;
  const lines = [];
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
  return lines.join('\r\n');
}

function buildMimeMessage(options) {
  const opts = options || {};
  const to = normalizeAddressList(opts.to, 5).join(', ');
  if (!to) throw new Error('At least one recipient is required.');
  const cc = opts.cc ? normalizeAddressList(opts.cc, 5).join(', ') : '';
  const bcc = opts.bcc ? normalizeAddressList(opts.bcc, 5).join(', ') : '';
  const subject = stripCrLf(opts.subject || '');
  if (!subject) throw new Error('Email subject is required.');
  const body = String(opts.body || '');
  if (!body.trim()) throw new Error('Email body is required.');

  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    opts.replyTo ? `Reply-To: ${normalizeAddress(opts.replyTo)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ].filter(Boolean);

  const encodedBody = wrapBase64(Buffer.from(body, 'utf8').toString('base64'));
  const raw = headers.join('\r\n') + '\r\n\r\n' + encodedBody + '\r\n';
  return {
    raw,
    rawBase64Url: Buffer.from(raw, 'utf8').toString('base64url'),
    to,
    cc,
    bcc,
    subject,
    body
  };
}

function decodeBase64Url(data) {
  if (!data) return '';
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function headerMap(headers) {
  const map = {};
  for (const header of headers || []) {
    if (!header || !header.name) continue;
    map[String(header.name).toLowerCase()] = String(header.value || '');
  }
  return map;
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(payload) {
  if (!payload) return { text: '', html: false };
  const mimeType = String(payload.mimeType || '');
  if (payload.body && payload.body.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (mimeType === 'text/html') return { text: decodeHtml(decoded), html: true };
    if (mimeType === 'text/plain' || !mimeType) return { text: decoded, html: false };
  }
  const parts = payload.parts || [];
  let textPart = null;
  let htmlPart = null;
  for (const part of parts) {
    const result = extractBody(part);
    if (!result.text) continue;
    if (!result.html && !textPart) textPart = result;
    if (result.html && !htmlPart) htmlPart = result;
  }
  return textPart || htmlPart || { text: '', html: false };
}

function messageSummary(message) {
  const headers = headerMap(message && message.payload && message.payload.headers);
  const body = extractBody(message && message.payload);
  return {
    id: message && message.id,
    threadId: message && message.threadId,
    labelIds: (message && message.labelIds) || [],
    internalDate: message && message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : null,
    from: headers.from || '',
    to: headers.to || '',
    cc: headers.cc || '',
    subject: headers.subject || '',
    date: headers.date || '',
    messageId: headers['message-id'] || '',
    inReplyTo: headers['in-reply-to'] || '',
    snippet: message && message.snippet ? String(message.snippet).slice(0, 500) : '',
    bodyText: String(body.text || '').slice(0, 8000)
  };
}

function threadSummary(thread, options) {
  const opts = options || {};
  const messages = (thread && thread.messages) || [];
  const summaries = messages.map(messageSummary);
  return {
    id: thread && thread.id,
    historyId: thread && thread.historyId,
    messageCount: summaries.length,
    latest: summaries.length ? summaries[summaries.length - 1] : null,
    messages: opts.includeMessages === false ? summaries.slice(-1) : summaries
  };
}

function threadToText(thread) {
  return thread.messages
    .map(
      (message) =>
        `From: ${message.from}\nTo: ${message.to}\nDate: ${message.date}\nSubject: ${message.subject}\n\n${message.bodyText}`
    )
    .join('\n\n---\n\n');
}

module.exports = {
  EMAIL_RE,
  stripCrLf,
  encodeHeader,
  normalizeAddress,
  normalizeAddressList,
  buildMimeMessage,
  decodeBase64Url,
  headerMap,
  extractBody,
  messageSummary,
  threadSummary,
  threadToText
};
