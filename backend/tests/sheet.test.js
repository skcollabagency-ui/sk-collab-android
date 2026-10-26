'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSheetModel,
  detectHeaderRow,
  buildWriteRow,
  searchRecords,
  recordsForWorkbook,
  recordsByRole,
  inferRole,
  mapHeader,
  parseNumber,
  parseDate
} = require('../src/sheetModel');
const { buildWorkbook, VALUES } = require('./support');

test('detects real worksheet roles and headers dynamically', () => {
  const workbook = buildWorkbook();
  const byTitle = {};
  for (const sheet of workbook.sheets) byTitle[sheet.title] = sheet;
  assert.equal(byTitle.Brands.role, 'brands');
  assert.equal(byTitle.Creators.role, 'creators');
  assert.equal(byTitle.Outreach.role, 'outreach');
  assert.equal(byTitle.Campaigns.role, 'campaigns');
  assert.equal(byTitle.Tasks.role, 'tasks');
  assert.equal(byTitle.Brands.headerRowNumber, 1);
  assert.equal(byTitle.Brands.fields.brandName, 0);
  assert.equal(byTitle.Brands.fields.brandEmail, 6);
  assert.equal(byTitle.Creators.fields.rate, 4);
  assert.equal(byTitle.Outreach.fields.followUpDate, 4);
});

test('detects a header row after a title preamble without rewriting data', () => {
  const values = [
    ['SK Collab Agency snapshot'],
    [],
    ['Brand Name', 'Category', 'Budget', 'Requirements'],
    ['Acme', 'Beauty', '50000', '10k followers']
  ];
  const detected = detectHeaderRow(values);
  assert.equal(detected.headerRow, 2);
  const model = buildSheetModel({ title: 'Brands', sheetId: 1, index: 0 }, { values });
  assert.deepEqual(model.headers, ['Brand Name', 'Category', 'Budget', 'Requirements']);
  assert.equal(model.dataRows.length, 1);
  assert.equal(model.dataRows[0].rowNumber, 4);
});

test('maps aliases and infers roles from headers when title is unclear', () => {
  assert.equal(mapHeader('Brand / Company'), 'brandName');
  assert.equal(mapHeader('E-mail Address'), 'email');
  assert.equal(mapHeader('Next Follow-up Date'), 'followUpDate');
  assert.equal(mapHeader('Agency Commission %'), 'commission');
  const headers = ['Creator', 'Platform', 'Niche', 'Followers', 'Rate'];
  const model = buildSheetModel({ title: 'Master Data' }, {
    values: [headers, ['Riya', 'Instagram', 'Beauty', '25000', '20000']]
  });
  assert.equal(model.role, 'creators');
});

test('builds write rows only for existing columns and reports missing columns', () => {
  const workbook = buildWorkbook();
  const brands = workbook.sheets.find((sheet) => sheet.title === 'Brands');
  const built = buildWriteRow(
    brands,
    {
      brandName: 'New Brand',
      category: 'Fashion',
      email: 'new@brand.example',
      budget: '25000'
    },
    { nameField: 'brandName' }
  );
  assert.deepEqual(built.missingColumns, []);
  assert.equal(built.values[brands.fields.brandName], 'New Brand');
  assert.equal(built.values[brands.fields.brandEmail], 'new@brand.example');
  assert.equal(built.values[brands.fields.category], 'Fashion');

  const missing = buildWriteRow(
    brands,
    { brandName: 'New Brand', phone: '+919999999999' },
    { nameField: 'brandName' }
  );
  assert.ok(missing.missingColumns.includes('phone'));
});

test('search is normalized and searches real rows', () => {
  const workbook = buildWorkbook();
  const brands = recordsByRole(workbook, ['brands']);
  const result = searchRecords(brands, 'acme beauty', 10);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].mapped.brandName, 'Acme Beauty');
  assert.equal(result.matches[0].rowNumber, 2);
});

test('parses numeric and date values without inventing defaults', () => {
  assert.deepEqual(parseNumber('₹20,000'), { value: 20000, currency: '₹' });
  assert.deepEqual(parseNumber('25k followers'), { value: 25000, currency: '' });
  assert.equal(parseNumber(''), null);
  assert.equal(parseDate('2026-10-30').toISOString().slice(0, 10), '2026-10-30');
  assert.equal(parseDate('30/10/2026').toISOString().slice(0, 10), '2026-10-30');
  assert.equal(parseDate('not a date'), null);
});

test('workbook records preserve actual headers and row references', () => {
  const workbook = buildWorkbook();
  const records = recordsForWorkbook(workbook);
  const outreach = records.find((record) => record.sheetTitle === 'Outreach');
  assert.equal(outreach.values.Email, 'riya@creator.example');
  assert.equal(outreach.mapped.outreachStatus, 'Reply received');
  assert.equal(outreach.rowNumber, 2);
});

test('fixture has not been mutated by mapping', () => {
  const workbook = buildWorkbook();
  const brands = workbook.sheets.find((sheet) => sheet.title === 'Brands');
  assert.equal(brands.rawValues === undefined, true);
  assert.deepEqual(VALUES.Brands[0][0], 'Brand Name');
});
