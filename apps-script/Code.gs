var ENTRY_HEADERS = [
  'txn_id',
  '日期',
  '金額',
  '付款人',
  '分攤方式',
  '分類',
  '交易對象',
  '記帳人',
  '來源',
  '沖銷txn_id',
];
var ENTRY_SHEET_NAME = '帳目';
var CATEGORY_SHEET_NAME = '分類';
var PARTNER_SETTING_PREFIX = '夥伴:';
var SPLIT_MODES = ['這筆平分', '幫狗狗付', '幫自己付'];
var SETTLEMENT_CATEGORY = '結清';
// A refund of a shared purchase, written only by the dashboard import.
var REFUND_CATEGORY = '退款';
// Optional: a book without this column holds only BOOK_CURRENCY amounts.
var CURRENCY_HEADER = '幣別';

var MAX_LIST_TRANSACTIONS = 200;
var MAX_SNAPSHOT_RECORDS = 200;
// The book has no currency column: the entry app records every amount in TWD.
var BOOK_CURRENCY = 'TWD';
// txn_id is each entry's stable identity: the snapshot refuses duplicates and
// exposes an entry without one as unidentified (null) rather than guessing.
var PARTNER_CAPABILITIES = ['complete-revisioned-reads', 'stable-identity'];
// Durable dashboard-import operations. The sheet is created by the editor-run
// setupIntegrationSheet(); until it exists, commands answer unavailable.
var OPERATIONS_SHEET_NAME = '整合操作';
var OPERATION_HEADERS = [
  'operation_id',
  'content_digest',
  'kind',
  'txn_id',
  'personal_group_id',
  'committed_at',
];
var INTEGRATION_CAPABILITIES = ['durable-operation-outcomes', 'link-metadata', 'pending-confirmation-states'];
var INTEGRATION_SOURCE = 'dashboard-import';
var PENDING_CATEGORY = '尚未分類';
var NONCE_CACHE_SECONDS = 600;
var LOCK_WAIT_MILLISECONDS = 30000;
var SCHEMA_SHEET_NAMES = ['分類', '選項清單', '設定'];
var SPREADSHEET_ID_TAIL_LENGTH = 8;
var BACKUP_FOLDER_PROPERTY = 'LEDGER_BACKUP_FOLDER_ID';
var BACKUP_FOLDER_NAME = 'Partner Ledger backups';
var BACKUP_RETENTION_COUNT = 12;

function integrationState_() {
  if (!/^[0-9a-f]{40}$/.test(CONTRACT_VERSION) ||
      !/^[0-9a-f]{40}$/.test(APP_VERSION)) {
    throw new Error('系統版本不可用');
  }
  var open = PropertiesService.getScriptProperties().getProperty('INTEGRATION_OPEN') === 'true';
  return {
    book: 'partner',
    identity: { contractVersion: CONTRACT_VERSION, appVersion: APP_VERSION },
    maintenance: open ? { kind: 'open' } : { kind: 'maintenance', message: '系統更新中' },
    capabilities: PARTNER_CAPABILITIES.slice(),
    readAt: taipeiIsoNow_(),
  };
}

// Capabilities that depend on the integration sheet are reported only when it
// exists, so a caller never believes in outcomes this book cannot keep.
function integrationStateWithCapabilities_() {
  var state = integrationState_();
  try {
    var spreadsheet = SpreadsheetApp.openById(requiredProp_('LEDGER_SPREADSHEET_ID'));
    if (operationsSheet_(spreadsheet)) {
      state.capabilities = state.capabilities.concat(INTEGRATION_CAPABILITIES);
    }
  } catch (error) {
    // An unreadable integration sheet hides only the capabilities it backs.
  }
  return state;
}

function requireFinancialOpen_(payload) {
  var state = integrationState_();
  if (state.maintenance.kind !== 'open') {
    throw new Error('系統更新中');
  }
  if (!payload || payload.contractVersion !== CONTRACT_VERSION) {
    throw new Error('版本已更新，請重新整理頁面');
  }
}

function setMaintenance_(payload, nonce) {
  integrationState_();
  if (!payload || typeof payload.open !== 'boolean' ||
      String(payload.commandNonce || '') !== nonce ||
      payload.contractVersion !== CONTRACT_VERSION) {
    throw new Error('invalid maintenance command');
  }
  var commandTs = Number(payload.commandTs);
  if (!Number.isSafeInteger(commandTs)) {
    throw new Error('invalid maintenance command timestamp');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    var properties = PropertiesService.getScriptProperties();
    var previousText = properties.getProperty('MAINTENANCE_LAST_COMMAND');
    var previous = previousText ? JSON.parse(previousText) : null;
    if (previous) {
      if (!Number.isSafeInteger(previous.ts) || typeof previous.nonce !== 'string' ||
          typeof previous.open !== 'boolean') {
        throw new Error('maintenance command state unavailable');
      }
      if (commandTs < previous.ts ||
          (commandTs === previous.ts &&
            (nonce !== previous.nonce || payload.open !== previous.open))) {
        throw new Error('stale maintenance command');
      }
    }
    if (!previous || commandTs > previous.ts) {
      if (Math.abs(Date.now() - commandTs) > 300000) {
        throw new Error('maintenance command timestamp outside allowed window');
      }
      properties.setProperty('MAINTENANCE_LAST_COMMAND', JSON.stringify({
        ts: commandTs, nonce: nonce, open: payload.open,
      }));
    }
    properties.setProperty('INTEGRATION_OPEN', payload.open ? 'true' : 'false');
    return integrationState_();
  } finally {
    lock.releaseLock();
  }
}

function route_(payload, nonce) {
  var action = payload && payload.action;
  if (action === 'integrationState') {
    return integrationStateWithCapabilities_();
  }
  if (action === 'setMaintenance') {
    return setMaintenance_(payload, nonce);
  }
  if (action === 'outcome') {
    return outcome_(payload);
  }
  requireFinancialOpen_(payload);

  if (action === 'health') {
    return health_();
  }
  if (action === 'get_options') {
    return getOptions_();
  }
  if (action === 'list_transactions') {
    return listTransactions_(payload);
  }
  if (action === 'snapshot') {
    return snapshot_(payload);
  }
  if (action === 'command') {
    return command_(payload);
  }
  if (action === 'create_transaction') {
    return createTransaction_(payload, nonce);
  }
  if (action === 'settle') {
    return settle_(payload, nonce);
  }
  if (action === 'reverse_transaction') {
    return reverseTransaction_(payload, nonce);
  }

  throw new Error('unsupported action: ' + action);
}

function health_() {
  var spreadsheetId = requiredProp_('LEDGER_SPREADSHEET_ID');
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var schemaVersion = schemaVersion_(spreadsheet);
  var tailLength = Math.min(
    SPREADSHEET_ID_TAIL_LENGTH,
    Math.max(1, spreadsheetId.length - 1),
  );

  return {
    ok: true,
    now: new Date().toISOString(),
    schema_version: schemaVersion,
    spreadsheet_id_tail: spreadsheetId.slice(-tailLength),
  };
}

function schemaVersion_(spreadsheet) {
  var tables = [];

  for (var index = 0; index < SCHEMA_SHEET_NAMES.length; index += 1) {
    var sheetName = SCHEMA_SHEET_NAMES[index];
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      throw new Error('missing sheet: ' + sheetName);
    }

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    tables.push(
      lastRow === 0 || lastColumn === 0
        ? []
        : sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues(),
    );
  }

  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(tables),
  );
  return digestHex_(digest).slice(0, 12);
}

function digestHex_(bytes) {
  var hex = '';
  for (var index = 0; index < bytes.length; index += 1) {
    var unsignedByte = (bytes[index] + 256) % 256;
    hex += ('0' + unsignedByte.toString(16)).slice(-2);
  }
  return hex;
}

function getOptions_() {
  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  var schemaVersion = schemaVersion_(spreadsheet);
  var partners = readPartners_(spreadsheet);
  var categories = readCategories_(spreadsheet);
  var selectable = [];
  for (var index = 0; index < categories.length; index += 1) {
    if (categories[index] !== SETTLEMENT_CATEGORY && categories[index] !== REFUND_CATEGORY) {
      selectable.push(categories[index]);
    }
  }

  var optionsSheet = requiredSheet_(spreadsheet, '選項清單');
  var optionValues = optionsSheet
    .getRange(
      1,
      1,
      optionsSheet.getLastRow(),
      optionsSheet.getLastColumn(),
    )
    .getDisplayValues();
  var optionColumns = resolveHeaders_(optionValues[0], ['交易對象']);
  var payees = [];
  for (var rowIndex = 1; rowIndex < optionValues.length; rowIndex += 1) {
    var payee = String(
      optionValues[rowIndex][optionColumns['交易對象'] - 1] || '',
    ).trim();
    if (payee) {
      payees.push(payee);
    }
  }

  return {
    schema_version: schemaVersion,
    categories: selectable,
    payees: payees,
    partners: partners.names,
  };
}

function listTransactions_(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  requireField_(payload, 'date_from');
  requireField_(payload, 'date_to');

  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  var partners = readPartners_(spreadsheet);
  var entries = requiredSheet_(spreadsheet, ENTRY_SHEET_NAME);
  var lastColumn = entries.getLastColumn();
  var headerRow = entries
    .getRange(1, 1, 1, lastColumn)
    .getDisplayValues()[0];
  var columns = resolveHeaders_(headerRow, ENTRY_HEADERS);
  var rows = readEntryRows_(entries, columns);

  // Build voided set: txn_ids that have a 沖銷 mirror row pointing at them
  var voidedIds = Object.create(null);
  var rowIndex;
  for (rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    var linkedId = String(rows[rowIndex]['沖銷txn_id'] || '');
    if (linkedId !== '') {
      voidedIds[linkedId] = true;
    }
  }

  // Filter by date range
  var matches = [];
  for (rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    var row = rows[rowIndex];
    var date = String(row['日期'] || '');
    if (date < String(payload.date_from) || date > String(payload.date_to)) {
      continue;
    }
    var txnId = String(row['txn_id'] || '');
    var transaction = {};
    var headerIndex;
    for (headerIndex = 0; headerIndex < ENTRY_HEADERS.length; headerIndex += 1) {
      var header = ENTRY_HEADERS[headerIndex];
      transaction[header] = String(row[header] === undefined ? '' : row[header]);
    }
    // 金額 is a number in display values (already stringified above from getDisplayValues)
    transaction['幣別'] = row['幣別'];
    transaction['voided'] = txnId !== '' && Object.prototype.hasOwnProperty.call(voidedIds, txnId);
    transaction['sheetRow'] = row['sheetRow'];
    matches.push(transaction);
  }

  // Sort newest first by date, then by sheet row descending for ties
  matches.sort(function (left, right) {
    if (left['日期'] > right['日期']) {
      return -1;
    }
    if (left['日期'] < right['日期']) {
      return 1;
    }
    return right['sheetRow'] - left['sheetRow'];
  });

  // Remove sheetRow from output
  var result = [];
  var resultCount = Math.min(matches.length, MAX_LIST_TRANSACTIONS);
  for (var resultIndex = 0; resultIndex < resultCount; resultIndex += 1) {
    var out = {};
    var hIdx;
    for (hIdx = 0; hIdx < ENTRY_HEADERS.length; hIdx += 1) {
      out[ENTRY_HEADERS[hIdx]] = matches[resultIndex][ENTRY_HEADERS[hIdx]];
    }
    out['幣別'] = matches[resultIndex]['幣別'];
    out['voided'] = matches[resultIndex]['voided'];
    result.push(out);
  }

  return {
    transactions: result,
    payables: computePayables_(rows, partners.names),
  };
}

// A complete, revision-pinned read of every ledger entry for the dashboard.
// Unlike list_transactions it is never capped: a page that is not the last
// names a cursor, and every page belongs to one stated revision.
function snapshot_(payload) {
  if (!payload || (payload.scope !== 'agreements' && payload.scope !== 'settings')) {
    throw new Error('snapshot scope must be agreements or settings');
  }
  if (payload.interval !== undefined) {
    throw new Error('snapshot interval is not supported');
  }
  if (payload.cursor !== undefined && payload.snapshotRevision === undefined) {
    throw new Error('snapshot continuation requires snapshotRevision');
  }

  var spreadsheet = SpreadsheetApp.openById(
    requiredProp_('LEDGER_SPREADSHEET_ID'),
  );
  if (payload.scope === 'settings') {
    return settingsSnapshot_(spreadsheet, payload);
  }
  var partners = readPartners_(spreadsheet);
  var entries = requiredSheet_(spreadsheet, ENTRY_SHEET_NAME);
  var headerRow = entries
    .getRange(1, 1, 1, entries.getLastColumn())
    .getDisplayValues()[0];
  var columns = resolveHeaders_(headerRow, ENTRY_HEADERS);
  var rows = readEntryRows_(entries, columns);
  var operations = readOperations_(operationsSheet_(spreadsheet));
  var revision = digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify({ partners: partners.names, rows: rows, operations: operations }),
  ));
  if (
    payload.snapshotRevision !== undefined &&
    String(payload.snapshotRevision) !== revision
  ) {
    return {
      kind: 'revision-changed',
      book: 'partner',
      expected: String(payload.snapshotRevision),
      actual: revision,
    };
  }

  var records = snapshotEntryRecords_(rows, partners.names, operations);
  var offset = snapshotCursorOffset_(payload.cursor);
  if (offset > records.length) {
    throw new Error('snapshot cursor is outside the result');
  }
  var page = records.slice(offset, offset + MAX_SNAPSHOT_RECORDS);
  var nextOffset = offset + page.length;
  return {
    scope: 'agreements',
    snapshotRevision: revision,
    records: page,
    continuation: nextOffset < records.length
      ? { kind: 'cursor', cursor: String(nextOffset) }
      : { kind: 'end' },
    readAt: taipeiIsoNow_(),
  };
}

// The formal categories a Confirmation may choose, as one small page.
function settingsSnapshot_(spreadsheet, payload) {
  var categories = readCategories_(spreadsheet);
  var revision = digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(categories),
  ));
  if (payload.snapshotRevision !== undefined && String(payload.snapshotRevision) !== revision) {
    return {
      kind: 'revision-changed',
      book: 'partner',
      expected: String(payload.snapshotRevision),
      actual: revision,
    };
  }
  var records = [];
  for (var index = 0; index < categories.length; index += 1) {
    if (categories[index] !== SETTLEMENT_CATEGORY && categories[index] !== PENDING_CATEGORY) {
      records.push({ id: 'category:' + categories[index], kind: 'category', name: categories[index] });
    }
  }
  return {
    scope: 'settings',
    snapshotRevision: revision,
    records: records,
    continuation: { kind: 'end' },
    readAt: taipeiIsoNow_(),
  };
}

// Every non-blank entry row as a typed record. A row that cannot be read
// exactly fails the whole snapshot: a Settlement computed from the rows that
// happened to parse is not a Settlement.
function snapshotEntryRecords_(rows, partnerNames, operations) {
  var linkedGroup = Object.create(null);
  for (var operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    var operation = operations[operationIndex];
    if (operation.txn_id !== '' && operation.personal_group_id !== '') {
      linkedGroup[operation.txn_id] = operation.personal_group_id;
    }
  }
  var reversedBy = Object.create(null);
  var seenIds = Object.create(null);
  var index;
  for (index = 0; index < rows.length; index += 1) {
    var reversal = String(rows[index]['沖銷txn_id'] || '');
    if (reversal !== '') {
      if (reversedBy[reversal]) {
        throw new Error('entry reversed twice: ' + reversal);
      }
      reversedBy[reversal] = String(rows[index]['txn_id'] || '');
    }
  }

  var records = [];
  for (index = 0; index < rows.length; index += 1) {
    var row = rows[index];
    if (entryRowIsBlank_(row)) {
      continue;
    }
    var sheetRow = row.sheetRow;
    var txnId = String(row['txn_id'] || '').trim();
    if (txnId !== '') {
      if (seenIds[txnId]) {
        throw new Error('duplicate txn_id at row ' + sheetRow);
      }
      seenIds[txnId] = true;
    }
    var date = String(row['日期'] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('invalid 日期 at row ' + sheetRow);
    }
    var payer = String(row['付款人'] || '').trim();
    var payerIndex = partnerNames.indexOf(payer);
    if (payerIndex === -1) {
      throw new Error('unknown 付款人 at row ' + sheetRow);
    }
    var category = String(row['分類'] || '').trim();
    var settlement = category === SETTLEMENT_CATEGORY;
    var split = String(row['分攤方式'] || '').trim();
    if (!settlement && SPLIT_MODES.indexOf(split) === -1) {
      throw new Error('invalid 分攤方式 at row ' + sheetRow);
    }
    var currency = String(row[CURRENCY_HEADER] || BOOK_CURRENCY);
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error('invalid 幣別 at row ' + sheetRow);
    }
    var reverses = String(row['沖銷txn_id'] || '').trim();
    records.push({
      id: txnId === '' ? null : txnId,
      revision: entryRevision_(row),
      sheetRow: sheetRow,
      kind: settlement ? 'settlement' : category === REFUND_CATEGORY ? 'refund' : 'expense',
      financialDate: date,
      amount: { amount: entryAmountText_(row, sheetRow), currency: currency },
      payer: payer,
      otherParty: partnerNames[1 - payerIndex],
      split: settlement ? null : split,
      category: category,
      reverses: reverses === '' ? null : reverses,
      reversedBy: txnId !== '' && reversedBy[txnId] !== undefined
        ? reversedBy[txnId]
        : null,
      source: String(row['來源'] || ''),
      origin: String(row['來源'] || '') === INTEGRATION_SOURCE ? 'integration' : 'partner',
      link: txnId !== '' && linkedGroup[txnId] !== undefined
        ? { personalGroupId: linkedGroup[txnId] }
        : null,
    });
  }
  return records;
}

function entryRowIsBlank_(row) {
  for (var index = 0; index < ENTRY_HEADERS.length; index += 1) {
    var header = ENTRY_HEADERS[index];
    var value = header === '金額' ? row['金額顯示'] : row[header];
    if (String(value === undefined || value === null ? '' : value).trim() !== '') {
      return false;
    }
  }
  return true;
}

// The stored amount as an exact positive decimal string, never a float that
// has already been rounded for display.
function entryAmountText_(row, sheetRow) {
  var amount = row['金額'];
  var text = typeof amount === 'number' && isFinite(amount) ? String(amount) : '';
  if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) {
    throw new Error('invalid 金額 at row ' + sheetRow);
  }
  return text;
}

function entryRevision_(row) {
  return digestHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(row),
  ));
}

/* Durable dashboard-import commands ------------------------------------ */

function operationsSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(OPERATIONS_SHEET_NAME);
  if (!sheet || sheet.getLastColumn() === 0) {
    return null;
  }
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  return { sheet: sheet, columns: resolveHeaders_(header, OPERATION_HEADERS) };
}

function readOperations_(operations) {
  if (!operations) {
    return [];
  }
  var lastRow = operations.sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var values = operations.sheet
    .getRange(2, 1, lastRow - 1, operations.sheet.getLastColumn())
    .getDisplayValues();
  var result = [];
  for (var rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    var record = {};
    for (var headerIndex = 0; headerIndex < OPERATION_HEADERS.length; headerIndex += 1) {
      var header = OPERATION_HEADERS[headerIndex];
      record[header] = String(values[rowIndex][operations.columns[header] - 1] || '').trim();
    }
    if (record.operation_id !== '') {
      result.push(record);
    }
  }
  return result;
}

function findOperation_(operations, operationId) {
  for (var index = 0; index < operations.length; index += 1) {
    if (operations[index].operation_id === operationId) {
      return operations[index];
    }
  }
  return null;
}

function rowByTxnId_(rows, txnId) {
  for (var index = 0; index < rows.length; index += 1) {
    if (String(rows[index]['txn_id'] || '') === txnId) {
      return rows[index];
    }
  }
  return null;
}

function committedOutcome_(operation, rows) {
  var row = rowByTxnId_(rows, operation.txn_id);
  if (!row) {
    return {
      kind: 'incomplete',
      operationId: operation.operation_id,
      reason: 'recorded-entry-is-missing',
      destinations: [],
    };
  }
  return {
    kind: 'committed',
    operationId: operation.operation_id,
    destinations: [{ id: operation.txn_id, revision: entryRevision_(row) }],
    committedAt: operation.committed_at,
  };
}

function conflictOutcome_(operationId, reason, conflicts) {
  return { kind: 'conflict', operationId: operationId, reason: reason, conflicts: conflicts };
}

function rejectedOutcome_(operationId, reason) {
  return { kind: 'rejected', operationId: operationId, reason: reason };
}

// Discoverable after a lost response or an expired cache, and readable during
// maintenance, so a caller never has to guess from a replay refusal.
function outcome_(payload) {
  var operationId = String((payload && payload.operationId) || '').trim();
  if (!operationId) {
    throw new Error('operationId is required');
  }
  var spreadsheet = SpreadsheetApp.openById(requiredProp_('LEDGER_SPREADSHEET_ID'));
  var operation = findOperation_(readOperations_(operationsSheet_(spreadsheet)), operationId);
  if (!operation) {
    return { kind: 'unavailable', book: 'partner', reason: 'no-such-operation' };
  }
  var entries = requiredSheet_(spreadsheet, ENTRY_SHEET_NAME);
  var header = entries.getRange(1, 1, 1, entries.getLastColumn()).getDisplayValues()[0];
  return committedOutcome_(operation, readEntryRows_(entries, resolveHeaders_(header, ENTRY_HEADERS)));
}

// One conditional, replayable command. The entry's txn_id is the operation id,
// so a retry after the entry landed but before the operation was recorded
// finds that entry instead of appending a second one.
function command_(payload) {
  var operationId = String(payload.operationId || '').trim();
  if (!operationId) {
    throw new Error('operationId is required');
  }
  var digest = String(payload.contentDigest || '').trim();
  if (!digest) {
    throw new Error('contentDigest is required');
  }
  if (!Array.isArray(payload.expectedRevisions)) {
    throw new Error('expectedRevisions must be an array');
  }
  var content = payload.content;
  if (!content || typeof content !== 'object') {
    throw new Error('content is required');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);
  try {
    requireFinancialOpen_(payload);
    var spreadsheet = SpreadsheetApp.openById(requiredProp_('LEDGER_SPREADSHEET_ID'));
    var operations = operationsSheet_(spreadsheet);
    if (!operations) {
      return { kind: 'unavailable', book: 'partner', reason: 'integration-schema-unavailable' };
    }
    var entries = requiredSheet_(spreadsheet, ENTRY_SHEET_NAME);
    var header = entries.getRange(1, 1, 1, entries.getLastColumn()).getDisplayValues()[0];
    var columns = resolveHeaders_(header, ENTRY_HEADERS);
    var rows = readEntryRows_(entries, columns);

    var recorded = findOperation_(readOperations_(operations), operationId);
    if (recorded) {
      if (recorded.content_digest !== digest) {
        return conflictOutcome_(operationId, 'operation-id-reused-with-different-content', []);
      }
      return committedOutcome_(recorded, rows);
    }

    if (content.kind === 'confirm-agreement') {
      return confirmAgreement_(spreadsheet, entries, columns, rows, operations, operationId, digest, content,
        payload.expectedRevisions);
    }

    var conflicts = [];
    for (var index = 0; index < payload.expectedRevisions.length; index += 1) {
      var expected = payload.expectedRevisions[index] || {};
      var expectedId = String(expected.id || '');
      var row = rowByTxnId_(rows, expectedId);
      var actual = row ? entryRevision_(row) : 'missing';
      if (actual !== String(expected.revision || '')) {
        conflicts.push({ id: expectedId, expected: String(expected.revision || ''), actual: actual });
      }
    }
    if (conflicts.length > 0) {
      return conflictOutcome_(operationId, 'expected-revision-changed', conflicts);
    }

    if (content.kind === 'partner-agreement') {
      return createAgreement_(spreadsheet, entries, columns, rows, operations, operationId, digest, content);
    }
    return rejectedOutcome_(operationId, 'unsupported-command-kind');
  } finally {
    lock.releaseLock();
  }
}

function createAgreement_(spreadsheet, entries, columns, rows, operations, operationId, digest, content) {
  var partners = readPartners_(spreadsheet);
  var built = agreementEntry_(content, partners.names, readCategories_(spreadsheet), operationId,
    currencyColumn_(entries) > 0);
  if (built.error) {
    return rejectedOutcome_(operationId, built.error);
  }
  var existing = rowByTxnId_(rows, operationId);
  if (!existing && built.row['分類'] === SETTLEMENT_CATEGORY) {
    var payables = computePayables_(rows, partners.names);
    var directions = payables.directions;
    if (built.row[CURRENCY_HEADER] !== BOOK_CURRENCY) {
      directions = [];
      for (var currencyIndex = 0; currencyIndex < payables.otherCurrencies.length; currencyIndex += 1) {
        if (payables.otherCurrencies[currencyIndex].currency === built.row[CURRENCY_HEADER]) {
          directions = payables.otherCurrencies[currencyIndex].directions;
        }
      }
    }
    var outstanding = 0;
    for (var index = 0; index < directions.length; index += 1) {
      if (directions[index].debtor === built.row['付款人']) {
        outstanding = normalizedAmount_(directions[index].outstanding);
      }
    }
    if (built.row['金額'] > outstanding) {
      return rejectedOutcome_(operationId, 'settlement-exceeds-outstanding');
    }
  }
  if (existing) {
    if (!sameEntry_(existing, built.row)) {
      return conflictOutcome_(operationId, 'entry-exists-with-different-content', []);
    }
  } else {
    appendEntry_(entries, columns, built.row);
  }
  var operation = recordOperation_(operations, {
    operation_id: operationId,
    content_digest: digest,
    kind: 'partner-agreement',
    txn_id: operationId,
    personal_group_id: String(content.groupId || ''),
  });
  return committedOutcome_(operation, readEntryRows_(entries, columns));
}

function recordOperation_(operations, operation) {
  operation.committed_at = taipeiIsoNow_();
  var values = [];
  for (var columnIndex = 0; columnIndex < operations.sheet.getLastColumn(); columnIndex += 1) {
    values.push('');
  }
  for (var headerIndex = 0; headerIndex < OPERATION_HEADERS.length; headerIndex += 1) {
    var name = OPERATION_HEADERS[headerIndex];
    values[operations.columns[name] - 1] = operation[name];
  }
  operations.sheet
    .getRange(operations.sheet.getLastRow() + 1, 1, 1, values.length)
    .setValues([values]);
  return operation;
}

// Confirmation (已確認) gives a pending agreement its formal category. It is
// judged on the state it produces: an entry already holding the requested
// category is the answer to a retry whose response was lost, while anything
// else that moved since review is a conflict. An invalid confirmation writes
// nothing at all.
function confirmAgreement_(spreadsheet, entries, columns, rows, operations, operationId, digest, content,
    expectedRevisions) {
  var agreementId = String(content.agreementId || '');
  var category = String(content.category || '');
  if (category === '' || category === PENDING_CATEGORY || category === SETTLEMENT_CATEGORY ||
      readCategories_(spreadsheet).indexOf(category) === -1) {
    return rejectedOutcome_(operationId, 'confirmation-needs-a-formal-category');
  }
  var row = rowByTxnId_(rows, agreementId);
  if (!row) {
    return rejectedOutcome_(operationId, 'unknown-agreement');
  }
  if (String(row['分類'] || '') === SETTLEMENT_CATEGORY || String(row['沖銷txn_id'] || '') !== '' ||
      reversedTxnIds_(rows)[agreementId]) {
    return rejectedOutcome_(operationId, 'agreement-cannot-be-confirmed');
  }
  var expected = null;
  for (var index = 0; index < expectedRevisions.length; index += 1) {
    if (expectedRevisions[index] && String(expectedRevisions[index].id || '') === agreementId) {
      expected = String(expectedRevisions[index].revision || '');
    }
  }
  if (expected === null) {
    return rejectedOutcome_(operationId, 'confirmation-needs-the-reviewed-revision');
  }

  var alreadyConfirmed = String(row['分類'] || '') === category;
  if (!alreadyConfirmed) {
    var actual = entryRevision_(row);
    if (actual !== expected) {
      return conflictOutcome_(operationId, 'expected-revision-changed',
        [{ id: agreementId, expected: expected, actual: actual }]);
    }
    entries.getRange(row.sheetRow, columns['分類'], 1, 1).setValues([[category]]);
  }

  var stored = rowByTxnId_(readEntryRows_(entries, columns), agreementId);
  if (!stored || String(stored['分類'] || '') !== category) {
    return {
      kind: 'incomplete',
      operationId: operationId,
      reason: 'confirmation-not-visible-in-the-resulting-entry',
      destinations: [],
    };
  }
  var operation = recordOperation_(operations, {
    operation_id: operationId,
    content_digest: digest,
    kind: 'confirm-agreement',
    txn_id: agreementId,
    personal_group_id: '',
  });
  return committedOutcome_(operation, readEntryRows_(entries, columns));
}

// The agreement as a Partner-book row. The dashboard speaks of cheng and the
// partner; the book speaks of participant names, so `selfName` says which
// name is cheng. A USD agreement is refused, never converted: this book has
// no currency column and would otherwise add it into TWD.
function agreementEntry_(content, partnerNames, categories, txnId, hasCurrencyColumn) {
  var self = String(content.selfName || '');
  var selfIndex = partnerNames.indexOf(self);
  if (selfIndex === -1) {
    return { error: 'self-name-is-not-a-partner' };
  }
  var other = partnerNames[1 - selfIndex];
  if (content.payer !== 'cheng' && content.payer !== 'partner') {
    return { error: 'invalid-payer' };
  }
  var payer = content.payer === 'cheng' ? self : other;
  if (content.purpose !== 'shared-purchase' && content.purpose !== 'shared-settlement' &&
      content.purpose !== 'shared-refund') {
    return { error: 'purpose-not-supported-by-partner-book' };
  }
  var settlement = content.purpose === 'shared-settlement';
  // A refund keeps the original purchase and records, beside it, that its
  // payer now holds the other person's share of what came back. Both gross
  // directions stay visible and no bank fact is changed.
  var refund = content.purpose === 'shared-refund';
  var split = '';
  if (settlement) {
    // A settlement is a payment between the two of them; no split applies.
  } else if (content.allocation === 'equal-halves') {
    split = '這筆平分';
  } else if (content.allocation === 'entirely-cheng' || content.allocation === 'entirely-partner') {
    var payerBears = (content.allocation === 'entirely-cheng') === (content.payer === 'cheng');
    split = payerBears ? '幫自己付' : '幫狗狗付';
  } else {
    return { error: 'invalid-allocation' };
  }
  var total = content.total || {};
  if (typeof total.currency !== 'string' || !/^[A-Z]{3}$/.test(total.currency) ||
      (total.currency !== BOOK_CURRENCY && !hasCurrencyColumn)) {
    return { error: 'currency-not-supported-by-partner-book' };
  }
  var amountText = String(total.amount || '');
  if (!/^\d+(\.\d+)?$/.test(amountText) || Number(amountText) <= 0 ||
      String(Number(amountText)) !== amountText.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')) {
    return { error: 'amount-not-exactly-storable' };
  }
  var date = String(content.effectiveDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'invalid-effective-date' };
  }
  var category = settlement
    ? SETTLEMENT_CATEGORY
    : refund ? REFUND_CATEGORY
    : content.category === undefined ? PENDING_CATEGORY : String(content.category);
  if (!settlement && !refund && (category === SETTLEMENT_CATEGORY || category === REFUND_CATEGORY ||
      (category !== PENDING_CATEGORY && categories.indexOf(category) === -1))) {
    return { error: 'unknown-category' };
  }
  var row = entryRow_({
    txnId: txnId,
    date: date,
    amount: Number(amountText),
    payer: payer,
    split: split,
    category: category,
    payee: settlement ? '' : String(content.payee || ''),
    enterer: self,
    source: INTEGRATION_SOURCE,
    reversalTxnId: '',
  });
  row[CURRENCY_HEADER] = total.currency;
  return { row: row };
}

function sameEntry_(stored, row) {
  var fields = ['txn_id', '日期', '付款人', '分攤方式', '分類', '來源', '沖銷txn_id', CURRENCY_HEADER];
  for (var index = 0; index < fields.length; index += 1) {
    if (String(stored[fields[index]] || '') !== String(row[fields[index]] || '')) {
      return false;
    }
  }
  return Number(stored['金額']) === Number(row['金額']);
}

// Editor-run only: creates the integration sheet on an existing book.
function setupIntegrationSheet() {
  var spreadsheet = SpreadsheetApp.openById(requiredProp_('LEDGER_SPREADSHEET_ID'));
  initializeBlankSheet_(getOrCreateSheet_(spreadsheet, OPERATIONS_SHEET_NAME), [OPERATION_HEADERS]);
  // An empty 幣別 cell means TWD, so adding the column changes no amount.
  var entries = requiredSheet_(spreadsheet, ENTRY_SHEET_NAME);
  if (currencyColumn_(entries) === 0) {
    entries.getRange(1, entries.getLastColumn() + 1, 1, 1).setValues([[CURRENCY_HEADER]]);
  }
}

function snapshotCursorOffset_(cursor) {
  if (cursor === undefined) {
    return 0;
  }
  var text = String(cursor);
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new Error('invalid snapshot cursor');
  }
  var offset = Number(text);
  if (!Number.isSafeInteger(offset)) {
    throw new Error('invalid snapshot cursor');
  }
  return offset;
}

function normalizedAmount_(amount) {
  return Math.round(amount * 1000000000) / 1000000000;
}

function createTransaction_(payload, nonce) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  requireField_(payload, 'idempotencyKey');
  requireField_(payload, 'userEmail');
  requireField_(payload, 'transaction');

  var idempotencyKey = String(payload.idempotencyKey);
  if (idempotencyKey !== nonce) {
    throw new Error('idempotencyKey must match nonce');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);

  try {
    requireFinancialOpen_(payload);
    var cache = CacheService.getScriptCache();
    var nonceKey = 'nonce:' + nonce;
    var storedResult = cache.get(nonceKey);
    if (storedResult) {
      return withAlready_(JSON.parse(storedResult));
    }

    var spreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    var entries = requiredSheet_(spreadsheet, ENTRY_SHEET_NAME);
    var headerRow = entries
      .getRange(1, 1, 1, entries.getLastColumn())
      .getDisplayValues()[0];
    var columns = resolveHeaders_(headerRow, ENTRY_HEADERS);
    var partners = readPartners_(spreadsheet);
    var enterer = partners.byEmail[String(payload.userEmail).toLowerCase()];
    if (!enterer) {
      throw new Error('unknown user email: ' + payload.userEmail);
    }

    var existingRow = findTxnRow_(
      entries,
      columns['txn_id'],
      idempotencyKey,
    );
    if (existingRow !== null) {
      var existingResult = {
        ok: true,
        txn_id: idempotencyKey,
        row: existingRow,
        already: true,
      };
      cache.put(
        nonceKey,
        JSON.stringify(existingResult),
        NONCE_CACHE_SECONDS,
      );
      return existingResult;
    }

    var transaction = payload.transaction;

    var categories = readCategories_(spreadsheet);
    if (categories.indexOf(transaction.category) === -1) {
      throw new Error('unknown 分類: ' + transaction.category);
    }

    var row = expandEntry_({
      kind: 'create',
      date: transaction.date,
      amount: transaction.amount,
      payer: transaction.payer,
      split: transaction.split,
      category: transaction.category,
      payee: transaction.payee,
      enterer: enterer,
      partners: partners.names,
      txnId: idempotencyKey,
    });
    var rowNumber = appendEntry_(entries, columns, row);
    var result = {
      ok: true,
      txn_id: idempotencyKey,
      row: rowNumber,
    };
    cache.put(nonceKey, JSON.stringify(result), NONCE_CACHE_SECONDS);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function settle_(payload, nonce) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  requireField_(payload, 'idempotencyKey');
  requireField_(payload, 'userEmail');
  requireField_(payload, 'date');
  requireField_(payload, 'amount');
  requireField_(payload, 'payer');

  var idempotencyKey = String(payload.idempotencyKey);
  if (idempotencyKey !== nonce) {
    throw new Error('idempotencyKey must match nonce');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);

  try {
    requireFinancialOpen_(payload);
    var cache = CacheService.getScriptCache();
    var nonceKey = 'nonce:' + nonce;
    var storedResult = cache.get(nonceKey);
    if (storedResult) {
      return withAlready_(JSON.parse(storedResult));
    }

    var spreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    var entries = requiredSheet_(spreadsheet, ENTRY_SHEET_NAME);
    var headerRow = entries
      .getRange(1, 1, 1, entries.getLastColumn())
      .getDisplayValues()[0];
    var columns = resolveHeaders_(headerRow, ENTRY_HEADERS);
    var partners = readPartners_(spreadsheet);
    var enterer = partners.byEmail[String(payload.userEmail).toLowerCase()];
    if (!enterer) {
      throw new Error('unknown user email: ' + payload.userEmail);
    }

    var existingRow = findTxnRow_(
      entries,
      columns['txn_id'],
      idempotencyKey,
    );
    if (existingRow !== null) {
      var existingResult = {
        ok: true,
        txn_id: idempotencyKey,
        row: existingRow,
        already: true,
      };
      cache.put(
        nonceKey,
        JSON.stringify(existingResult),
        NONCE_CACHE_SECONDS,
      );
      return existingResult;
    }

    var row = expandEntry_({
      kind: 'settle',
      date: payload.date,
      amount: payload.amount,
      payer: payload.payer,
      enterer: enterer,
      partners: partners.names,
      txnId: idempotencyKey,
    });
    var rows = readEntryRows_(entries, columns);
    var payables = computePayables_(rows, partners.names);
    var outstanding = 0;
    for (var directionIndex = 0; directionIndex < payables.directions.length; directionIndex += 1) {
      var direction = payables.directions[directionIndex];
      if (direction.debtor === payload.payer) {
        outstanding = direction.outstanding;
        break;
      }
    }

    if (payload.amount > outstanding) {
      throw new Error(
        'over-settlement: amount ' +
          payload.amount +
          ' exceeds outstanding ' +
          outstanding,
      );
    }

    var rowNumber = appendEntry_(entries, columns, row);
    var result = {
      ok: true,
      txn_id: idempotencyKey,
      row: rowNumber,
      outstanding: normalizedAmount_(outstanding - payload.amount),
    };
    cache.put(nonceKey, JSON.stringify(result), NONCE_CACHE_SECONDS);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function reverseTransaction_(payload, nonce) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }
  requireField_(payload, 'idempotencyKey');
  requireField_(payload, 'userEmail');
  requireField_(payload, 'txn_id');
  requireField_(payload, 'date');

  var idempotencyKey = String(payload.idempotencyKey);
  if (idempotencyKey !== nonce) {
    throw new Error('idempotencyKey must match nonce');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MILLISECONDS);

  try {
    requireFinancialOpen_(payload);
    var cache = CacheService.getScriptCache();
    var nonceKey = 'nonce:' + nonce;
    var storedResult = cache.get(nonceKey);

    var spreadsheet = SpreadsheetApp.openById(
      requiredProp_('LEDGER_SPREADSHEET_ID'),
    );
    var entries = requiredSheet_(spreadsheet, ENTRY_SHEET_NAME);
    var headerRow = entries
      .getRange(1, 1, 1, entries.getLastColumn())
      .getDisplayValues()[0];
    var columns = resolveHeaders_(headerRow, ENTRY_HEADERS);
    var partners = readPartners_(spreadsheet);
    var enterer = partners.byEmail[String(payload.userEmail).toLowerCase()];
    if (!enterer) {
      throw new Error('unknown user email: ' + payload.userEmail);
    }
    var rows = readEntryRows_(entries, columns);
    var targetTxnId = String(payload.txn_id);
    var index;
    for (index = 0; index < rows.length; index += 1) {
      if (rows[index]['txn_id'] === idempotencyKey) {
        if (rows[index]['沖銷txn_id'] !== targetTxnId) {
          throw new Error('idempotency key already used for another reversal');
        }
        var durableResult = {
          ok: true, txn_id: idempotencyKey, row: rows[index].sheetRow, already: true,
        };
        cache.put(nonceKey, JSON.stringify(durableResult), NONCE_CACHE_SECONDS);
        return durableResult;
      }
    }
    if (storedResult) {
      throw new Error('cached reversal has no durable row');
    }

    for (index = 0; index < rows.length; index += 1) {
      if (
        rows[index]['沖銷txn_id'] === targetTxnId
      ) {
        return {
          ok: true, txn_id: rows[index]['txn_id'], row: rows[index].sheetRow, already: true,
        };
      }
    }

    var original = null;
    for (index = 0; index < rows.length; index += 1) {
      if (rows[index]['txn_id'] === targetTxnId) {
        original = rows[index];
        break;
      }
    }
    if (original === null) {
      throw new Error('unknown txn_id: ' + targetTxnId);
    }

    if (original['沖銷txn_id'] !== '') {
      throw new Error('cannot reverse reversal row: ' + targetTxnId);
    }

    var row = expandEntry_({
      kind: 'reverse',
      date: payload.date,
      original: original,
      enterer: enterer,
      partners: partners.names,
      txnId: idempotencyKey,
    });

    var rowNumber = appendEntry_(entries, columns, row);
    var result = {
      ok: true,
      txn_id: idempotencyKey,
      row: rowNumber,
    };
    cache.put(nonceKey, JSON.stringify(result), NONCE_CACHE_SECONDS);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function readPartners_(spreadsheet) {
  var settings = requiredSheet_(spreadsheet, '設定');
  var lastRow = settings.getLastRow();
  var lastColumn = settings.getLastColumn();
  var values = settings
    .getRange(1, 1, lastRow, lastColumn)
    .getDisplayValues();
  var columns = resolveHeaders_(values[0], ['設定項目', '值']);
  var entries = [];

  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    var row = values[rowIndex];
    var setting = String(row[columns['設定項目'] - 1] || '').trim();
    if (setting.indexOf(PARTNER_SETTING_PREFIX) !== 0) {
      continue;
    }
    entries.push({
      email: setting.slice(PARTNER_SETTING_PREFIX.length).trim().toLowerCase(),
      name: String(row[columns['值'] - 1] || '').trim(),
    });
  }

  if (
    entries.length !== 2 ||
    !entries[0].name ||
    !entries[1].name ||
    entries[0].name === entries[1].name
  ) {
    throw new Error('設定 must map exactly two partners');
  }

  var names = [entries[0].name, entries[1].name];
  var byEmail = {};
  byEmail[entries[0].email] = entries[0].name;
  byEmail[entries[1].email] = entries[1].name;
  return { names: names, byEmail: byEmail };
}

function readCategories_(spreadsheet) {
  var categoriesSheet = requiredSheet_(spreadsheet, CATEGORY_SHEET_NAME);
  var lastRow = categoriesSheet.getLastRow();
  var lastColumn = categoriesSheet.getLastColumn();
  var values = categoriesSheet
    .getRange(1, 1, lastRow, lastColumn)
    .getDisplayValues();
  var columns = resolveHeaders_(values[0], ['分類']);
  var categories = [];

  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    var category = String(values[rowIndex][columns['分類'] - 1] || '').trim();
    if (category) {
      categories.push(category);
    }
  }
  return categories;
}

function appendEntry_(entries, columns, row) {
  var rowNumber = entries.getLastRow() + 1;
  var columnCount = entries.getLastColumn();
  var values = [];
  var index;

  for (index = 0; index < columnCount; index += 1) {
    values.push('');
  }
  for (index = 0; index < ENTRY_HEADERS.length; index += 1) {
    var header = ENTRY_HEADERS[index];
    values[columns[header] - 1] = row[header];
  }
  var currencyColumn = currencyColumn_(entries);
  var currency = row[CURRENCY_HEADER] || BOOK_CURRENCY;
  if (currencyColumn > 0) {
    values[currencyColumn - 1] = currency === BOOK_CURRENCY ? '' : currency;
  } else if (currency !== BOOK_CURRENCY) {
    throw new Error('this book has no 幣別 column for ' + currency);
  }

  entries.getRange(rowNumber, 1, 1, columnCount).setValues([values]);
  return rowNumber;
}

function readEntryRows_(entries, columns) {
  var lastRow = entries.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var lastColumn = entries.getLastColumn();
  var range = entries.getRange(2, 1, lastRow - 1, lastColumn);
  var rawRows = range.getValues();
  var displayRows = range.getDisplayValues();
  var currencyColumn = currencyColumn_(entries);
  var rows = [];
  for (var rowIndex = 0; rowIndex < rawRows.length; rowIndex += 1) {
    var row = { sheetRow: rowIndex + 2 };
    for (var headerIndex = 0; headerIndex < ENTRY_HEADERS.length; headerIndex += 1) {
      var header = ENTRY_HEADERS[headerIndex];
      row[header] = displayRows[rowIndex][columns[header] - 1];
    }
    row['金額'] = Number(rawRows[rowIndex][columns['金額'] - 1]);
    row['金額顯示'] = displayRows[rowIndex][columns['金額'] - 1];
    var currencyText = currencyColumn > 0
      ? String(displayRows[rowIndex][currencyColumn - 1] || '').trim()
      : '';
    row[CURRENCY_HEADER] = currencyText === '' ? BOOK_CURRENCY : currencyText;
    rows.push(row);
  }
  return rows;
}

// The 1-based 幣別 column, or 0 when the book predates it.
function currencyColumn_(entries) {
  var lastColumn = entries.getLastColumn();
  if (lastColumn === 0) {
    return 0;
  }
  var header = entries.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  for (var index = 0; index < header.length; index += 1) {
    if (String(header[index] || '').trim() === CURRENCY_HEADER) {
      return index + 1;
    }
  }
  return 0;
}

function findTxnRow_(journal, txnColumn, idempotencyKey) {
  var lastRow = journal.getLastRow();
  if (lastRow < 2) {
    return null;
  }

  var values = journal
    .getRange(2, txnColumn, lastRow - 1, 1)
    .getDisplayValues();
  for (var index = 0; index < values.length; index += 1) {
    if (String(values[index][0]) === idempotencyKey) {
      return index + 2;
    }
  }
  return null;
}

function requiredSheet_(spreadsheet, name) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    throw new Error('missing sheet: ' + name);
  }
  return sheet;
}

function withAlready_(result) {
  var replay = {};
  for (var key in result) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      replay[key] = result[key];
    }
  }
  replay.already = true;
  return replay;
}

function taipeiIsoNow_() {
  var offsetMilliseconds = 8 * 60 * 60 * 1000;
  return new Date(Date.now() + offsetMilliseconds)
    .toISOString()
    .replace('Z', '+08:00');
}

function resolveHeaders_(headerRow, requiredHeaders) {
  var required = Object.create(null);
  var positions = Object.create(null);
  var duplicates = [];
  var missing = [];
  var resolved = {};
  var index;

  for (index = 0; index < requiredHeaders.length; index += 1) {
    required[requiredHeaders[index]] = true;
  }

  for (index = 0; index < headerRow.length; index += 1) {
    var value = headerRow[index];
    var header = value === null || value === undefined ? '' : String(value).trim();
    if (!Object.prototype.hasOwnProperty.call(required, header)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(positions, header)) {
      if (duplicates.indexOf(header) === -1) {
        duplicates.push(header);
      }
    } else {
      positions[header] = index + 1;
    }
  }

  if (duplicates.length > 0) {
    throw new Error('duplicate required header: ' + duplicates.join(', '));
  }

  for (index = 0; index < requiredHeaders.length; index += 1) {
    var requiredHeader = requiredHeaders[index];
    if (!Object.prototype.hasOwnProperty.call(positions, requiredHeader)) {
      missing.push(requiredHeader);
    } else {
      resolved[requiredHeader] = positions[requiredHeader];
    }
  }

  if (missing.length > 0) {
    throw new Error('missing required header: ' + missing.join(', '));
  }

  return resolved;
}

// Editor-installed weekly backup is intentionally not routed through
// doPost: Drive operations must never be remotely invocable through the API.
function weeklyBackup() {
  var spreadsheetId = requiredProp_('LEDGER_SPREADSHEET_ID');
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var folder = backupFolder_();
  var backupPrefix = spreadsheet.getName() + ' backup ';
  var timestamp = taipeiIsoNow_()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}\+0800$/, '');
  var name = backupPrefix + timestamp;
  var copy = DriveApp.getFileById(spreadsheetId).makeCopy(name, folder);
  var pruned = pruneBackups_(folder, backupPrefix, spreadsheetId);
  var prunedNames = [];

  for (var index = 0; index < pruned.length; index += 1) {
    prunedNames.push(pruned[index].getName());
  }
  return {
    ok: true,
    file_id: copy.getId(),
    name: copy.getName(),
    pruned: prunedNames,
  };
}

function backupFolder_() {
  var properties = PropertiesService.getScriptProperties();
  var folderId = properties.getProperty(BACKUP_FOLDER_PROPERTY);
  if (folderId) {
    return DriveApp.getFolderById(folderId);
  }

  var folder = DriveApp.createFolder(BACKUP_FOLDER_NAME);
  properties.setProperty(BACKUP_FOLDER_PROPERTY, folder.getId());
  return folder;
}

function pruneBackups_(folder, backupPrefix, sourceFileId) {
  var iterator = folder.getFiles();
  var files = [];
  while (iterator.hasNext()) {
    var file = iterator.next();
    if (
      file.getId() === sourceFileId ||
      file.getName().indexOf(backupPrefix) !== 0
    ) {
      continue;
    }
    files.push(file);
  }
  files.sort(function (left, right) {
    var createdDifference =
      right.getDateCreated().getTime() - left.getDateCreated().getTime();
    if (createdDifference !== 0) {
      return createdDifference;
    }
    var leftName = left.getName();
    var rightName = right.getName();
    if (leftName === rightName) {
      return 0;
    }
    return leftName < rightName ? 1 : -1;
  });

  var pruned = [];
  for (
    var index = BACKUP_RETENTION_COUNT;
    index < files.length;
    index += 1
  ) {
    files[index].setTrashed(true);
    pruned.push(files[index]);
  }
  return pruned;
}

function installWeeklyTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  var index;

  for (index = 0; index < existing.length; index += 1) {
    if (existing[index].getHandlerFunction() === 'weeklyBackup') {
      ScriptApp.deleteTrigger(existing[index]);
    }
  }

  ScriptApp.newTrigger('weeklyBackup')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();
}

// Editor-run only: setupSpreadsheet is never routed through doPost.
function setupSpreadsheet() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty(
    'LEDGER_SPREADSHEET_ID',
  );
  if (!spreadsheetId) {
    throw new Error('missing Script Property: LEDGER_SPREADSHEET_ID');
  }

  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var entries = getOrCreateSheet_(spreadsheet, ENTRY_SHEET_NAME);
  var categories = getOrCreateSheet_(spreadsheet, CATEGORY_SHEET_NAME);
  var options = getOrCreateSheet_(spreadsheet, '選項清單');
  var settings = getOrCreateSheet_(spreadsheet, '設定');

  initializeBlankSheet_(entries, [ENTRY_HEADERS]);
  initializeBlankSheet_(categories, [
    ['分類'],
    [SETTLEMENT_CATEGORY],
    ['餐飲'],
    ['交通'],
  ]);
  initializeBlankSheet_(options, [['交易對象']]);
  initializeBlankSheet_(settings, [
    ['設定項目', '值'],
    ['夥伴:owner@example.com', '夥伴一'],
    ['夥伴:partner@example.com', '夥伴二'],
  ]);

  var headerRow = entries
    .getRange(1, 1, 1, entries.getLastColumn())
    .getValues()[0];
  var columns = resolveHeaders_(headerRow, ENTRY_HEADERS);
  entries
    .getRange(1, columns['日期'], entries.getMaxRows(), 1)
    .setNumberFormat('@');
}

function getOrCreateSheet_(spreadsheet, name) {
  var existing = spreadsheet.getSheetByName(name);
  if (existing) {
    return existing;
  }

  var sheets = spreadsheet.getSheets();
  if (
    sheets.length === 1 &&
    (sheets[0].getName() === 'Sheet1' || sheets[0].getName() === '工作表1') &&
    sheets[0].getLastRow() === 0 &&
    sheets[0].getLastColumn() === 0
  ) {
    return sheets[0].setName(name);
  }

  return spreadsheet.insertSheet(name);
}

function initializeBlankSheet_(sheet, rows) {
  if (sheet.getLastRow() !== 0 || sheet.getLastColumn() !== 0) {
    return;
  }
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
}

function requireField_(object, field) {
  if (!hasField_(object, field) || object[field] === '' || object[field] === null || object[field] === undefined) {
    throw new Error(field + ' is required');
  }
}

function hasField_(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field);
}

function validatePositiveAmount_(amount) {
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number');
  }
}

function blank_(value) {
  return value === undefined || value === null ? '' : value;
}

function expandEntry_(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('input is required');
  }

  if (input.kind === 'create') {
    return expandCreateEntry_(input);
  }
  if (input.kind === 'settle') {
    return expandSettleEntry_(input);
  }
  if (input.kind === 'reverse') {
    return expandReverseEntry_(input);
  }

  throw new Error('kind is invalid');
}

function expandCreateEntry_(input) {
  requireField_(input, 'date');

  if (
    typeof input.amount !== 'number' ||
    !isFinite(input.amount) ||
    input.amount <= 0
  ) {
    throw new Error('金額 must be a positive number');
  }

  validatePartnerName_(input.payer, input.partners, '付款人');

  if (SPLIT_MODES.indexOf(input.split) === -1) {
    throw new Error('分攤方式 is invalid');
  }

  requireField_(input, 'category');
  if (input.category === SETTLEMENT_CATEGORY) {
    throw new Error('分類 結清 is reserved for settlement rows');
  }
  if (input.category === REFUND_CATEGORY) {
    throw new Error('分類 退款 is reserved for imported refunds');
  }

  validatePartnerName_(input.enterer, input.partners, '記帳人');
  requireField_(input, 'txnId');

  return entryRow_({
    txnId: input.txnId,
    date: input.date,
    amount: input.amount,
    payer: input.payer,
    split: input.split,
    category: input.category,
    payee: input.payee,
    enterer: input.enterer,
    source: 'web-app',
    reversalTxnId: '',
  });
}

function expandSettleEntry_(input) {
  requireField_(input, 'date');
  if (
    typeof input.amount !== 'number' ||
    !isFinite(input.amount) ||
    input.amount <= 0
  ) {
    throw new Error('金額 must be a positive number');
  }
  validatePartnerName_(input.payer, input.partners, '付款人');
  validatePartnerName_(input.enterer, input.partners, '記帳人');
  requireField_(input, 'txnId');
  return entryRow_({
    txnId: input.txnId,
    date: input.date,
    amount: input.amount,
    payer: input.payer,
    split: '',
    category: SETTLEMENT_CATEGORY,
    payee: '',
    enterer: input.enterer,
    source: 'web-app',
    reversalTxnId: '',
  });
}

function expandReverseEntry_(input) {
  requireField_(input, 'date');
  requireField_(input, 'original');
  var original = input.original;
  requireField_(original, 'txn_id');
  if (
    typeof original['金額'] !== 'number' ||
    !isFinite(original['金額']) ||
    original['金額'] <= 0
  ) {
    throw new Error('金額 must be a positive number');
  }
  validatePartnerName_(input.enterer, input.partners, '記帳人');
  requireField_(input, 'txnId');
  return entryRow_({
    txnId: input.txnId,
    date: input.date,
    amount: original['金額'],
    payer: original['付款人'],
    split: original['分攤方式'],
    category: original['分類'],
    payee: original['交易對象'],
    enterer: input.enterer,
    source: 'web-app',
    reversalTxnId: original.txn_id,
  });
}

function validatePartnerName_(value, partners, label) {
  if (value === '' || value === null || value === undefined) {
    throw new Error(label + ' is required');
  }
  if (!Array.isArray(partners) || partners.indexOf(value) === -1) {
    throw new Error(label + ' must be one of the two partners');
  }
}

function entryRow_(fields) {
  return {
    'txn_id': blank_(fields.txnId),
    '日期': blank_(fields.date),
    '金額': fields.amount,
    '付款人': blank_(fields.payer),
    '分攤方式': blank_(fields.split),
    '分類': blank_(fields.category),
    '交易對象': blank_(fields.payee),
    '記帳人': blank_(fields.enterer),
    '來源': blank_(fields.source),
    '沖銷txn_id': blank_(fields.reversalTxnId),
  };
}

function reversedTxnIds_(rows) {
  var voided = Object.create(null);
  for (var index = 0; index < rows.length; index += 1) {
    var target = String(rows[index]['沖銷txn_id'] || '');
    if (target !== '') {
      voided[target] = true;
    }
  }
  return voided;
}

function computePayables_(rows, partners) {
  if (
    !Array.isArray(partners) ||
    partners.length !== 2 ||
    !partners[0] ||
    !partners[1] ||
    partners[0] === partners[1]
  ) {
    throw new Error('partners must be two distinct names');
  }

  var voided = reversedTxnIds_(rows);
  var owedByCurrency = Object.create(null);

  for (var index = 0; index < rows.length; index += 1) {
    var row = rows[index];
    if (String(row['沖銷txn_id'] || '') !== '') {
      continue;
    }
    var txnId = String(row['txn_id'] || '');
    if (txnId !== '' && voided[txnId]) {
      continue;
    }

    var currency = String(row[CURRENCY_HEADER] || BOOK_CURRENCY);
    if (!owedByCurrency[currency]) {
      owedByCurrency[currency] = Object.create(null);
      owedByCurrency[currency][partners[0]] = 0;
      owedByCurrency[currency][partners[1]] = 0;
    }
    var owedBy = owedByCurrency[currency];
    var amount = Number(row['金額']);
    var payer = String(row['付款人'] || '');
    var other = payer === partners[0] ? partners[1] : partners[0];
    var category = String(row['分類'] || '');

    if (category === SETTLEMENT_CATEGORY) {
      owedBy[payer] -= amount;
    } else if (category === REFUND_CATEGORY) {
      // The refund's recipient now holds the other person's share of it.
      owedBy[payer] += shareOf_(row['分攤方式'], amount);
    } else {
      owedBy[other] += shareOf_(row['分攤方式'], amount);
    }
  }

  var directionsFor = function (owed) {
    return [
      { debtor: partners[0], creditor: partners[1], outstanding: owed ? owed[partners[0]] : 0 },
      { debtor: partners[1], creditor: partners[0], outstanding: owed ? owed[partners[1]] : 0 },
    ];
  };
  // The app's balance is in the book's currency; any other currency is kept
  // apart and never added into it.
  var otherCurrencies = [];
  var currencies = Object.keys(owedByCurrency).sort();
  for (var currencyIndex = 0; currencyIndex < currencies.length; currencyIndex += 1) {
    if (currencies[currencyIndex] !== BOOK_CURRENCY) {
      otherCurrencies.push({
        currency: currencies[currencyIndex],
        directions: directionsFor(owedByCurrency[currencies[currencyIndex]]),
      });
    }
  }
  return {
    directions: directionsFor(owedByCurrency[BOOK_CURRENCY]),
    otherCurrencies: otherCurrencies,
  };
}

// What the non-payer's side of an amount is under a payer-relative split.
function shareOf_(split, amount) {
  if (split === '這筆平分') {
    return amount / 2;
  }
  if (split === '幫狗狗付') {
    return amount;
  }
  return 0;
}
