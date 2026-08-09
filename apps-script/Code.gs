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
var SPLIT_MODES = ['均分', '全額對方', '全額自己'];
var SETTLEMENT_CATEGORY = '結清';

var MAX_LIST_TRANSACTIONS = 200;
var MAX_SKEW_SECONDS = 300;
var NONCE_CACHE_SECONDS = 600;
var LOCK_WAIT_MILLISECONDS = 30000;
var SCHEMA_SHEET_NAMES = ['分類', '選項清單', '設定'];
var SPREADSHEET_ID_TAIL_LENGTH = 8;
var BACKUP_FOLDER_PROPERTY = 'LEDGER_BACKUP_FOLDER_ID';
var BACKUP_FOLDER_NAME = 'Partner Ledger backups';
var BACKUP_RETENTION_COUNT = 12;

function doPost(e) {
  try {
    var requestText =
      e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    var verified = verifyEnvelope_(JSON.parse(requestText));
    return json_(route_(verified.payload, verified.nonce));
  } catch (error) {
    return json_({
      ok: false,
      error: String(error && error.message ? error.message : error),
    });
  }
}

function route_(payload, nonce) {
  var action = payload && payload.action;

  if (action === 'health') {
    return health_();
  }
  if (action === 'get_options') {
    return getOptions_();
  }
  if (action === 'list_transactions') {
    return listTransactions_(payload);
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

function verifyEnvelope_(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('invalid envelope');
  }

  var ts = Number(envelope.ts);
  var nonce = String(envelope.nonce || '');
  var payloadB64 = String(envelope.payload || '');
  var sig = String(envelope.sig || '');

  if (!isFinite(ts)) {
    throw new Error('missing ts');
  }
  if (!nonce) {
    throw new Error('missing nonce');
  }
  if (!payloadB64) {
    throw new Error('missing payload');
  }
  if (!sig) {
    throw new Error('missing sig');
  }

  var now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) {
    throw new Error('request timestamp outside allowed window');
  }

  var secret = requiredProp_('EXPENSE_API_SECRET');
  var signingInput = ts + '.' + nonce + '.' + payloadB64;
  var expected = base64UrlEncode_(
    Utilities.computeHmacSha256Signature(signingInput, secret),
  );
  if (!constantTimeEqual_(sig, expected)) {
    throw new Error('bad signature');
  }

  var jsonText = Utilities.newBlob(base64UrlDecode_(payloadB64))
    .getDataAsString('UTF-8');
  return { payload: JSON.parse(jsonText), nonce: nonce };
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
    if (categories[index] !== SETTLEMENT_CATEGORY) {
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
    out['voided'] = matches[resultIndex]['voided'];
    result.push(out);
  }

  return {
    transactions: result,
    payables: computePayables_(rows, partners.names),
  };
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
    var rows = readEntryRows_(entries, columns);
    var targetTxnId = String(payload.txn_id);
    var index;

    for (index = 0; index < rows.length; index += 1) {
      if (
        rows[index]['沖銷txn_id'] === targetTxnId
      ) {
        var existingResult = { ok: true, already: true };
        cache.put(
          nonceKey,
          JSON.stringify(existingResult),
          NONCE_CACHE_SECONDS,
        );
        return existingResult;
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
  var rows = [];
  for (var rowIndex = 0; rowIndex < rawRows.length; rowIndex += 1) {
    var row = { sheetRow: rowIndex + 2 };
    for (var headerIndex = 0; headerIndex < ENTRY_HEADERS.length; headerIndex += 1) {
      var header = ENTRY_HEADERS[headerIndex];
      row[header] = displayRows[rowIndex][columns[header] - 1];
    }
    row['金額'] = Number(rawRows[rowIndex][columns['金額'] - 1]);
    row['金額顯示'] = displayRows[rowIndex][columns['金額'] - 1];
    rows.push(row);
  }
  return rows;
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

function requiredProp_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  if (!value) {
    throw new Error('missing script property: ' + name);
  }
  return value;
}

function json_(object) {
  return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function base64UrlEncode_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function base64UrlDecode_(text) {
  var normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) {
    normalized += '=';
  }
  return Utilities.base64Decode(normalized);
}

function constantTimeEqual_(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  var difference = 0;
  for (var index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
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
    source: 'pwa',
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
    source: 'pwa',
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
    source: 'pwa',
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
  var owedBy = Object.create(null);
  owedBy[partners[0]] = 0;
  owedBy[partners[1]] = 0;

  for (var index = 0; index < rows.length; index += 1) {
    var row = rows[index];
    if (String(row['沖銷txn_id'] || '') !== '') {
      continue;
    }
    var txnId = String(row['txn_id'] || '');
    if (txnId !== '' && voided[txnId]) {
      continue;
    }

    var amount = Number(row['金額']);
    var payer = String(row['付款人'] || '');
    var other = payer === partners[0] ? partners[1] : partners[0];

    if (String(row['分類'] || '') === SETTLEMENT_CATEGORY) {
      owedBy[payer] -= amount;
    } else if (row['分攤方式'] === '均分') {
      owedBy[other] += amount / 2;
    } else if (row['分攤方式'] === '全額對方') {
      owedBy[other] += amount;
    }
  }

  return {
    directions: [
      { debtor: partners[0], creditor: partners[1], outstanding: owedBy[partners[0]] },
      { debtor: partners[1], creditor: partners[0], outstanding: owedBy[partners[1]] },
    ],
  };
}
