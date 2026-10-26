'use strict';

const FIELD_ALIASES = {
  brandName: [
    'brand', 'brand name', 'brandname', 'brand company', 'company', 'company name',
    'client', 'client name', 'advertiser', 'business name'
  ],
  creatorName: [
    'creator', 'creator name', 'creator name', 'influencer', 'influencer name',
    'talent', 'talent name', 'content creator', 'creator profile name'
  ],
  name: ['name', 'full name', 'contact person', 'contact name', 'poc', 'spoc', 'person'],
  campaignName: ['campaign', 'campaign name', 'campaign title', 'project', 'project name'],
  email: ['email', 'email address', 'email id', 'e mail', 'mail', 'contact email', 'work email', 'business email'],
  brandEmail: ['brand email', 'brand contact email', 'client email', 'brand mail'],
  creatorEmail: ['creator email', 'creator contact email', 'influencer email', 'talent email'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'contact number', 'whatsapp', 'whatsapp number'],
  platform: ['platform', 'social platform', 'channel', 'network'],
  handle: [
    'handle', 'username', 'social handle', 'instagram', 'instagram handle', 'ig handle',
    'youtube', 'youtube channel', 'profile link', 'profile url', 'link', 'social link'
  ],
  category: ['category', 'niche', 'industry', 'vertical', 'content category', 'genre', 'creator type'],
  followers: ['followers', 'follower count', 'subscribers', 'subscriber count', 'audience size', 'followers count'],
  engagement: ['engagement', 'engagement rate', 'er'],
  rate: ['rate', 'creator rate', 'price', 'pricing', 'cost', 'charges', 'fee', 'per post rate', 'post rate', 'quoted rate'],
  availability: ['availability', 'available', 'available from', 'availability status'],
  location: ['location', 'city', 'state', 'country', 'region', 'geo'],
  language: ['language', 'languages', 'content language'],
  status: ['status', 'current status'],
  outreachStatus: ['outreach status', 'outreach', 'outreach stage', 'contact status', 'email status', 'outreach state'],
  dealStatus: ['deal status', 'deal stage', 'pipeline status', 'stage', 'deal', 'pipeline'],
  followUpDate: [
    'follow up date', 'followup date', 'follow up', 'next follow up', 'next followup',
    'follow up on', 'next action date', 'reminder date', 'next action'
  ],
  lastContact: ['last contact', 'last contacted', 'last contact date', 'last email', 'last outreach', 'last touch'],
  gmailThreadId: ['gmail thread id', 'thread id', 'gmail thread', 'gmail conversation id', 'email thread id'],
  gmailMessageId: ['gmail message id', 'message id', 'last message id'],
  commission: ['commission', 'commission percent', 'commission rate', 'agency commission'],
  paymentStatus: ['payment status', 'paid', 'payment', 'invoice status', 'payout status'],
  amount: ['amount', 'deal value', 'value', 'budget', 'total', 'payment amount', 'fees'],
  currency: ['currency', 'currency code'],
  requirements: ['requirements', 'brand requirements', 'brief', 'deliverables', 'requirement', 'campaign brief'],
  budget: ['budget range', 'campaign budget', 'max budget', 'min budget', 'budget per creator', 'budget'],
  notes: ['notes', 'remarks', 'comment', 'comments', 'note', 'description'],
  activity: ['activity', 'activity log', 'last activity', 'campaign activity', 'update', 'updates', 'log'],
  date: ['date', 'campaign date', 'created date', 'created at', 'timestamp', 'start date', 'end date'],
  deadline: ['deadline', 'due date', 'task date', 'completion date'],
  task: ['task', 'todo', 'to do', 'pending task', 'action item', 'task name'],
  brandId: ['brand id', 'brand code'],
  creatorId: ['creator id', 'creator code', 'influencer id'],
  campaignId: ['campaign id', 'campaign code']
};

const ROLE_ALIASES = {
  brands: ['brand', 'brands', 'clients', 'advertisers', 'companies'],
  creators: ['creator', 'creators', 'influencer', 'influencers', 'talent', 'talents', 'artists'],
  campaigns: ['campaign', 'campaigns', 'projects', 'briefs'],
  outreach: ['outreach', 'outreachs', 'outreach records', 'contacts', 'emails', 'email log', 'communication'],
  deals: ['deal', 'deals', 'pipeline', 'negotiations', 'negotiation', 'deals pipeline'],
  matches: ['match', 'matches', 'creator brand matches', 'creator matches', 'shortlist'],
  payments: ['payment', 'payments', 'invoices', 'payouts', 'accounts'],
  tasks: ['task', 'tasks', 'todo', 'todos', 'follow ups', 'followups', 'reminders'],
  reports: ['report', 'reports', 'daily report', 'daily reports', 'summary', 'summaries'],
  'brand requirements': ['brand requirements', 'requirements', 'briefs', 'brand briefs']
};

const CANONICAL_FIELDS = Object.keys(FIELD_ALIASES);

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALIZED_ALIASES = {};
for (const field of CANONICAL_FIELDS) {
  NORMALIZED_ALIASES[field] = FIELD_ALIASES[field].map(normalize);
}

function resolveFieldName(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (FIELD_ALIASES[raw]) return raw;
  const normalized = normalize(raw);
  for (const field of CANONICAL_FIELDS) {
    if (NORMALIZED_ALIASES[field].includes(normalized)) return field;
  }
  return null;
}

function mapHeader(header) {
  const normalized = normalize(header);
  if (!normalized) return null;
  let best = null;
  let bestScore = 0;
  for (const field of CANONICAL_FIELDS) {
    for (const alias of NORMALIZED_ALIASES[field]) {
      let score = 0;
      if (normalized === alias) score = 100 + alias.length;
      else if (normalized.startsWith(alias + ' ') || normalized.endsWith(' ' + alias)) {
        score = 40 + alias.length;
      } else if (normalized.includes(alias) && alias.length >= 4) {
        score = 20 + alias.length;
      }
      if (score > bestScore) {
        bestScore = score;
        best = field;
      }
    }
  }
  return bestScore >= 24 ? best : null;
}

function inferRole(title, headers, fields) {
  const normalizedTitle = normalize(title);
  let bestRole = null;
  let bestScore = 0;
  for (const role of Object.keys(ROLE_ALIASES)) {
    for (const alias of ROLE_ALIASES[role]) {
      const normAlias = normalize(alias);
      let score = 0;
      if (normalizedTitle === normAlias) score = 100;
      else if (normalizedTitle.includes(normAlias)) score = 60 + normAlias.length;
      if (score > bestScore) {
        bestScore = score;
        bestRole = role;
      }
    }
  }
  if (bestRole) return bestRole;

  const has = (field) => fields[field] !== undefined;
  if (has('brandName') && (has('requirements') || has('budget') || has('category'))) return 'brands';
  if (has('creatorName') && (has('followers') || has('rate') || has('availability'))) return 'creators';
  if (has('campaignName') && (has('budget') || has('deadline') || has('requirements'))) return 'campaigns';
  if (has('dealStatus') || has('commission')) return 'deals';
  if (has('outreachStatus') || has('followUpDate') || has('gmailThreadId')) return 'outreach';
  if (has('paymentStatus') || has('amount')) return 'payments';
  if (has('task') || has('deadline')) return 'tasks';
  if (has('creatorName') && has('brandName')) return 'matches';
  if (has('brandName')) return 'brands';
  if (has('creatorName')) return 'creators';
  if (has('campaignName')) return 'campaigns';
  return 'unknown';
}

function detectHeaderRow(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { headerRow: 0, headerScore: 0 };
  }
  let best = { headerRow: 0, headerScore: -1 };
  const limit = Math.min(values.length, 12);
  for (let i = 0; i < limit; i++) {
    const row = values[i] || [];
    let score = 0;
    let nonEmpty = 0;
    for (const cell of row) {
      if (String(cell || '').trim() === '') continue;
      nonEmpty++;
      if (mapHeader(cell)) score += 3;
    }
    score += Math.min(nonEmpty, 6);
    if (score > best.headerScore) best = { headerRow: i, headerScore: score };
  }
  if (best.headerScore < 5) {
    for (let i = 0; i < limit; i++) {
      if ((values[i] || []).some((cell) => String(cell || '').trim() !== '')) {
        return { headerRow: i, headerScore: 0 };
      }
    }
    return { headerRow: 0, headerScore: 0 };
  }
  return best;
}

function buildSheetModel(sheetMeta, valueRange) {
  const title = (sheetMeta && sheetMeta.title) || (valueRange && valueRange.range) || 'Sheet';
  const values = (valueRange && valueRange.values) || [];
  const detected = detectHeaderRow(values);
  const headerRowIndex = detected.headerRow;
  const rawHeaders = values[headerRowIndex] || [];
  const headers = rawHeaders.map((cell) => String(cell || '').trim());
  const fields = {};
  headers.forEach((header, index) => {
    if (!header) return;
    const field = mapHeader(header);
    if (field && fields[field] === undefined) fields[field] = index;
  });
  const role = inferRole(title, headers, fields);
  const dataRows = [];
  for (let i = headerRowIndex + 1; i < values.length; i++) {
    const row = values[i] || [];
    if (!row.some((cell) => String(cell || '').trim() !== '')) continue;
    dataRows.push({ values: row, rowNumber: i + 1 });
  }
  return {
    title,
    sheetId: sheetMeta && sheetMeta.sheetId,
    index: sheetMeta && sheetMeta.index,
    headers,
    fields,
    headerRowIndex,
    headerRowNumber: headerRowIndex + 1,
    role,
    dataRows,
    recordCount: dataRows.length,
    headerScore: detected.headerScore
  };
}

function valueAt(row, index) {
  if (index === undefined || index === null || index < 0) return '';
  return String(row[index] === undefined || row[index] === null ? '' : row[index]).trim();
}

function mappedValues(model, row) {
  const result = {};
  for (const field of Object.keys(model.fields)) {
    const value = valueAt(row, model.fields[field]);
    if (value !== '') result[field] = value;
  }
  return result;
}

function recordFromRow(model, rowInfo) {
  const mapped = mappedValues(model, rowInfo.values);
  const all = {};
  model.headers.forEach((header, index) => {
    if (!header) return;
    const value = valueAt(rowInfo.values, index);
    if (value !== '') all[header] = value;
  });
  return {
    sheetTitle: model.title,
    sheetRole: model.role,
    rowNumber: rowInfo.rowNumber,
    name: recordName(mapped),
    mapped,
    values: all
  };
}

function recordName(mapped) {
  return (
    mapped.brandName ||
    mapped.creatorName ||
    mapped.campaignName ||
    mapped.name ||
    mapped.task ||
    mapped.email ||
    mapped.brandEmail ||
    mapped.creatorEmail ||
    ''
  );
}

function recordEmail(mapped) {
  return (
    mapped.email ||
    mapped.brandEmail ||
    mapped.creatorEmail ||
    mapped.contactEmail ||
    ''
  );
}

function recordText(record) {
  return Object.keys(record.values)
    .map((key) => `${key}: ${record.values[key]}`)
    .join(' | ')
    .toLowerCase();
}

function recordsForWorkbook(workbook) {
  const result = [];
  for (const sheet of workbook.sheets) {
    for (const rowInfo of sheet.dataRows) {
      result.push(recordFromRow(sheet, rowInfo));
    }
  }
  return result;
}

function sheetsByRole(workbook, roles) {
  const accepted = Array.isArray(roles) ? roles : [roles];
  const matched = workbook.sheets.filter((sheet) => accepted.includes(sheet.role));
  return matched.length ? matched : [];
}

function recordsByRole(workbook, roles) {
  const sheets = sheetsByRole(workbook, roles);
  if (!sheets.length) return [];
  const result = [];
  for (const sheet of sheets) {
    for (const rowInfo of sheet.dataRows) {
      result.push(recordFromRow(sheet, rowInfo));
    }
  }
  return result;
}

function searchRecords(records, query, limit) {
  const needle = normalize(query);
  const max = Math.max(1, Math.min(Number(limit || 25), 100));
  const matches = [];
  for (const record of records) {
    if (!needle || normalize(recordText(record)).includes(needle)) {
      matches.push(record);
      if (matches.length >= max) break;
    }
  }
  return { matches, total: matches.length, truncated: matches.length >= max };
}

function inputToCanonical(input) {
  const result = {};
  const unknown = {};
  for (const key of Object.keys(input || {})) {
    const field = resolveFieldName(key) || (CANONICAL_FIELDS.includes(key) ? key : null);
    if (!field) {
      unknown[key] = input[key];
      continue;
    }
    const value = input[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      result[field] = value;
    }
  }
  return { fields: result, unknown };
}

function buildWriteRow(model, input, options) {
  const opts = options || {};
  const parsed = inputToCanonical(input);
  const values = new Array(model.headers.length).fill('');
  const usedFields = {};
  const missingColumns = [];

  for (const field of Object.keys(parsed.fields)) {
    let index = model.fields[field];
    if (index === undefined && field === 'brandName') index = model.fields.name;
    if (index === undefined && field === 'creatorName') index = model.fields.name;
    if (index === undefined && field === 'email') {
      if (model.role === 'brands') index = model.fields.brandEmail;
      else if (model.role === 'creators') index = model.fields.creatorEmail;
    }
    if (index === undefined && field === 'budget') index = model.fields.amount;
    if (index === undefined && field === 'amount') index = model.fields.budget;
    if (index === undefined && field === 'brandEmail' && model.role === 'brands') {
      index = model.fields.email;
    }
    if (index === undefined && field === 'creatorEmail' && model.role === 'creators') {
      index = model.fields.email;
    }
    if (index === undefined) {
      missingColumns.push(field);
      continue;
    }
    if (values[index] !== '') {
      missingColumns.push(`${field} conflicts with ${model.headers[index]}`);
      continue;
    }
    values[index] = parsed.fields[field];
    usedFields[field] = model.headers[index];
  }

  const nameField = opts.nameField || null;
  if (nameField) {
    const hasName =
      parsed.fields[nameField] ||
      parsed.fields.name ||
      (nameField === 'brandName' && parsed.fields.company) ||
      (nameField === 'creatorName' && parsed.fields.influencer);
    const nameIndex = model.fields[nameField];
    const genericIndex = model.fields.name;
    if (!hasName) {
      missingColumns.push(nameField);
    } else if (nameIndex === undefined && genericIndex === undefined) {
      missingColumns.push(nameField);
    }
  }

  return {
    values,
    mappedFields: usedFields,
    missingColumns: Array.from(new Set(missingColumns)),
    unknownFields: parsed.unknown,
    inputFields: parsed.fields
  };
}

function parseNumber(value) {
  const text = String(value || '').replace(/,/g, '').trim();
  if (!text) return null;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return null;
  let number = Number(match[1]);
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') number *= 1000;
  if (suffix === 'm') number *= 1000000;
  if (suffix === 'b') number *= 1000000000;
  return { value: number, currency: (text.match(/[₹$€£]/) || [''])[0] };
}

function parseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1])));
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}

module.exports = {
  FIELD_ALIASES,
  ROLE_ALIASES,
  CANONICAL_FIELDS,
  normalize,
  resolveFieldName,
  mapHeader,
  inferRole,
  detectHeaderRow,
  buildSheetModel,
  recordFromRow,
  recordName,
  recordEmail,
  recordsForWorkbook,
  recordsByRole,
  sheetsByRole,
  searchRecords,
  buildWriteRow,
  parseNumber,
  parseDate,
  valueAt
};
