'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listTools,
  previewTool,
  executeTool,
  ToolError
} = require('../src/tools');
const { fakeContext, fakeStore } = require('./support');

test('all requested spreadsheet and Gmail tools are registered', () => {
  const context = fakeContext();
  const tools = listTools(context);
  const names = tools.map((tool) => tool.name);
  for (const expected of [
    'get_spreadsheet_status',
    'list_worksheets',
    'get_sheet_headers',
    'search_brands',
    'search_creators',
    'get_campaigns',
    'find_creator_brand_matches',
    'get_outreach_status',
    'get_pending_followups',
    'add_brand',
    'add_creator',
    'update_outreach_status',
    'update_deal_status',
    'log_campaign_activity',
    'generate_agency_report',
    'get_gmail_status',
    'search_emails',
    'get_email_thread',
    'summarize_business_replies',
    'create_email_draft',
    'list_drafts',
    'send_approved_email',
    'identify_pending_replies'
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  const writes = tools.filter((tool) => tool.requiresApproval).map((tool) => tool.name);
  assert.deepEqual(writes.sort(), [
    'add_brand',
    'add_creator',
    'log_campaign_activity',
    'send_approved_email',
    'update_deal_status',
    'update_outreach_status'
  ]);
  assert.equal(tools.every((tool) => tool.available), true);
});

test('status tools stay available when Google is not connected; data tools do not', () => {
  const context = fakeContext({ store: fakeStore({ tokens: null }) });
  const tools = listTools(context);
  const byName = {};
  for (const tool of tools) byName[tool.name] = tool;
  assert.equal(byName.get_spreadsheet_status.available, true);
  assert.equal(byName.get_gmail_status.available, true);
  assert.equal(byName.search_brands.available, false);
  assert.match(byName.search_brands.availabilityReason, /authorization/i);
});

test('search_brands and search_creators return real mapped rows', async () => {
  const context = fakeContext();
  const brands = await executeTool(context, 'search_brands', { query: 'acme' });
  assert.equal(brands.totalMatches, 1);
  assert.equal(brands.records[0].mapped.brandName, 'Acme Beauty');
  const creators = await executeTool(context, 'search_creators', { query: 'beauty' });
  assert.equal(creators.totalMatches, 1);
  assert.equal(creators.records[0].mapped.creatorName, 'Riya Sharma');
  assert.equal(creators.records[0].mapped.rate, '20000');
});

test('find_creator_brand_matches uses real criteria and reports gaps', async () => {
  const context = fakeContext();
  const result = await executeTool(context, 'find_creator_brand_matches', {
    brand: 'Acme Beauty',
    limit: 3
  });
  assert.equal(result.brand.mapped.brandName, 'Acme Beauty');
  assert.equal(result.candidates[0].creator.mapped.creatorName, 'Riya Sharma');
  assert.equal(result.candidates[0].score, 100);
  assert.ok(result.candidates[0].reasons.includes('category matches'));
  assert.ok(result.candidates.some((candidate) => candidate.gaps.length > 0));
});

test('pending follow-ups include overdue and upcoming spreadsheet rows', async () => {
  const context = fakeContext();
  const result = await executeTool(context, 'get_pending_followups', { daysAhead: 30 });
  assert.ok(result.pendingCount >= 2);
  const names = result.pendingFollowups.map((item) => `${item.name} ${item.task}`);
  assert.ok(names.some((name) => name.includes('Trail Gear')));
  assert.ok(names.some((name) => name.includes('Send Acme follow-up')));
});

test('agency report uses worksheet facts and status counts', async () => {
  const context = fakeContext();
  const report = await executeTool(context, 'generate_agency_report', {});
  assert.equal(report.totalRecords, 9);
  assert.equal(report.spreadsheetTitle, 'SK Collab Agency Test Fixture');
  assert.ok(report.worksheets.some((sheet) => sheet.title === 'Brands'));
  assert.ok(report.byRole.creators.recordCount === 3);
  assert.ok(report.byRole.outreach.statusCounts['Reply received'] === 1);
});

test('add_brand refuses unknown columns and never adds a column silently', async () => {
  const context = fakeContext();
  await assert.rejects(
    () => previewTool(context, 'add_brand', {
      fields: { brandName: 'No Phone Brand', phone: '+919999999999' }
    }),
    (error) =>
      error instanceof ToolError &&
      error.code === 'MISSING_COLUMN' &&
      error.details.missingFields.includes('phone')
  );
  assert.equal(context.google.calls.sheetsAppend.length, 0);
});

test('add_brand appends exact mapped fields after a preview', async () => {
  const context = fakeContext();
  const preview = await previewTool(context, 'add_brand', {
    fields: {
      brandName: 'Fresh Brand',
      category: 'Fashion',
      email: 'fresh@brand.example',
      budget: '25000'
    }
  });
  assert.equal(preview.worksheet, 'Brands');
  assert.ok(preview.fields.some((field) => field.column === 'Brand Name' && field.value === 'Fresh Brand'));
  assert.ok(preview.fields.some((field) => field.column === 'Brand Email' && field.value === 'fresh@brand.example'));
  const result = await executeTool(context, 'add_brand', {
    fields: {
      brandName: 'Fresh Brand',
      category: 'Fashion',
      email: 'fresh@brand.example',
      budget: '25000'
    }
  });
  assert.equal(result.worksheet, 'Brands');
  const append = context.google.calls.sheetsAppend[0];
  assert.ok(append);
  const brands = context.store;
  assert.ok(brands);
  assert.ok(append.values[0].includes('Fresh Brand'));
  assert.ok(append.values[0].includes('fresh@brand.example'));
});

test('update_outreach_status previews and updates only the exact cell', async () => {
  const context = fakeContext();
  const preview = await previewTool(context, 'update_outreach_status', {
    query: 'Trail Gear',
    status: 'Follow-up sent'
  });
  assert.equal(preview.worksheet, 'Outreach');
  assert.equal(preview.rowNumber, 3);
  assert.equal(preview.currentValue, 'Waiting for reply');
  const result = await executeTool(context, 'update_outreach_status', {
    query: 'Trail Gear',
    status: 'Follow-up sent'
  });
  assert.equal(result.newValue, 'Follow-up sent');
  assert.equal(result.range, "'Outreach'!D3");
  assert.equal(context.google.calls.sheetsBatchUpdate[0].length, 1);
});

test('log_campaign_activity refuses to invent a missing activity column', async () => {
  const workbook = require('./support').buildWorkbook();
  const campaigns = workbook.sheets.find((sheet) => sheet.title === 'Campaigns');
  delete campaigns.fields.activity;
  delete campaigns.fields.date;
  const context = fakeContext({ workbook });
  await assert.rejects(
    () =>
      previewTool(context, 'log_campaign_activity', {
        query: 'Acme Beauty',
        worksheet: 'Campaigns',
        activity: 'Test update'
      }),
    (error) => error instanceof ToolError && error.code === 'MISSING_COLUMN'
  );
});

test('Gmail status is honest about missing write configuration', async () => {
  const context = fakeContext({ config: { enableGmailWrite: false } });
  const status = await executeTool(context, 'get_gmail_status', {});
  assert.equal(status.connected, true);
  assert.equal(status.capabilities.read, true);
  assert.equal(status.capabilities.draft, false);
  assert.equal(status.capabilities.send, false);
});

test('create_email_draft saves a real MIME draft and never sends', async () => {
  const context = fakeContext();
  const result = await executeTool(context, 'create_email_draft', {
    to: 'Riya <riya@creator.example>',
    subject: 'SK Collab Agency outreach',
    body: 'Hello Riya, please share your availability.'
  });
  assert.equal(result.created, true);
  assert.equal(result.sent, false);
  assert.equal(context.google.calls.gmailSend.length, 0);
  assert.equal(context.google.calls.gmailCreateDraft.length, 1);
});

test('send preview requires exact content and a second send is blocked by idempotency', async () => {
  const context = fakeContext();
  const args = {
    to: 'brand@example.com',
    subject: 'Creator proposal',
    body: 'Please find the creator details.'
  };
  const preview = await previewTool(context, 'send_approved_email', args);
  assert.equal(preview.to, 'brand@example.com');
  assert.equal(preview.subject, 'Creator proposal');
  assert.match(preview.warning, /send a real email/);
  const sent = await executeTool(context, 'send_approved_email', args);
  assert.equal(sent.sent, true);
  assert.equal(context.google.calls.gmailSend.length, 1);
  await assert.rejects(
    () => previewTool(context, 'send_approved_email', args),
    (error) => error instanceof ToolError && error.code === 'DUPLICATE_SEND'
  );
});

test('identify_pending_replies searches unread mail and changes nothing', async () => {
  const context = fakeContext();
  const result = await executeTool(context, 'identify_pending_replies', { maxResults: 5 });
  assert.equal(result.pendingCount, 0);
  assert.match(context.google.calls.gmailListMessages[0].query, /is:unread/);
  assert.match(result.note, /No messages were marked read/);
});

test('summarize_business_replies returns real thread text when backend AI is absent', async () => {
  const context = fakeContext();
  context.google.gmailListMessages = async () => ({
    messages: [{ id: 'm1', threadId: 't1' }]
  });
  context.google.gmailGetThread = async () => ({
    id: 't1',
    messages: [
      {
        id: 'm1',
        threadId: 't1',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Brand <brand@example.com>' },
            { name: 'Subject', value: 'Campaign reply' }
          ],
          body: { data: Buffer.from('Please share the creator rate.').toString('base64url') }
        }
      }
    ]
  });
  const result = await executeTool(context, 'summarize_business_replies', {});
  assert.equal(result.ai.available, false);
  assert.match(result.threadText, /Please share the creator rate/);
  assert.match(result.instruction, /never invent/);
});
