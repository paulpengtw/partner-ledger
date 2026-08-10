import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const deployDocPath = fileURLToPath(
  new URL('../../DEPLOY.md', import.meta.url),
)
const appsScriptPath = fileURLToPath(
  new URL('../../apps-script/Code.gs', import.meta.url),
)
const handlerPath = fileURLToPath(
  new URL('../../functions/lib/handler.ts', import.meta.url),
)

const deployDoc = readFileSync(deployDocPath, 'utf-8')
const appsScriptSource = readFileSync(appsScriptPath, 'utf-8')
const handlerSource = readFileSync(handlerPath, 'utf-8')

function extractSingleQuotedList(
  source: string,
  anchor: RegExp,
  label: string,
  expectedCount?: number,
): string[] {
  const match = source.match(anchor)
  if (!match) {
    throw new Error(`${label} anchor was not found in its source file`)
  }

  const values: string[] = []
  for (const value of (match[1] ?? '').matchAll(/'([^']+)'/g)) {
    const extracted = value[1]
    if (extracted === undefined) {
      throw new Error(`${label} anchor contained an unextractable value`)
    }
    values.push(extracted)
  }
  if (values.length === 0) {
    throw new Error(`${label} anchor yielded no single-quoted values`)
  }
  if (expectedCount !== undefined && values.length !== expectedCount) {
    throw new Error(
      `${label} anchor yielded ${values.length} values; expected ${expectedCount}`,
    )
  }

  return values
}

function extractSingleQuotedValue(
  source: string,
  anchor: RegExp,
  label: string,
): string {
  const match = source.match(anchor)
  const value = match?.[1]
  if (!value) {
    throw new Error(`${label} anchor was not found in its source file`)
  }
  return value
}

const entryHeaders = extractSingleQuotedList(
  appsScriptSource,
  /var\s+ENTRY_HEADERS\s*=\s*\[([\s\S]*?)\]/,
  'ENTRY_HEADERS',
  10,
)
const entrySheetName = extractSingleQuotedValue(
  appsScriptSource,
  /var\s+ENTRY_SHEET_NAME\s*=\s*'([^']+)'\s*;/,
  'ENTRY_SHEET_NAME',
)
const schemaSheetNames = extractSingleQuotedList(
  appsScriptSource,
  /var\s+SCHEMA_SHEET_NAMES\s*=\s*\[([\s\S]*?)\]/,
  'SCHEMA_SHEET_NAMES',
)
const sheetNames = [entrySheetName, ...schemaSheetNames]
if (sheetNames.length === 0) {
  throw new Error('Spreadsheet setup sheet extraction yielded no sheet names')
}

const allowedActions = extractSingleQuotedList(
  handlerSource,
  /const\s+ALLOWED\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/,
  'ALLOWED',
  7,
)

describe('DEPLOY.md', () => {
  it('documents every action extracted from the Pages Function allowlist', () => {
    for (const action of allowedActions) {
      expect(
        deployDoc.includes(action),
        `DEPLOY.md is missing allowed action "${action}"`,
      ).toBe(true)
    }
  })

  it('does not document removed actions', () => {
    for (const action of ['list_receivables', 'check_consistency']) {
      expect(
        deployDoc.includes(action),
        `DEPLOY.md still mentions removed action "${action}"`,
      ).toBe(false)
    }
  })

  it('documents every header extracted from ENTRY_HEADERS', () => {
    for (const header of entryHeaders) {
      expect(
        deployDoc.includes(header),
        `DEPLOY.md is missing ENTRY_HEADERS header "${header}"`,
      ).toBe(true)
    }
  })

  it('documents the setup sheets and no dead solo-ledger sheet names', () => {
    for (const sheetName of sheetNames) {
      expect(
        deployDoc.includes(sheetName),
        `DEPLOY.md is missing setup sheet "${sheetName}"`,
      ).toBe(true)
    }

    for (const sheetName of ['日記帳', '會計科目', '餘額', '試算與檢查']) {
      expect(
        deployDoc.includes(sheetName),
        `DEPLOY.md still mentions dead solo-ledger sheet "${sheetName}"`,
      ).toBe(false)
    }
  })

  it('does not document functions that do not exist in this fork', () => {
    for (const functionName of ['weeklyConsistencyCheck', 'closeAndOpenBooks']) {
      expect(
        deployDoc.includes(functionName),
        `DEPLOY.md still mentions nonexistent function "${functionName}"`,
      ).toBe(false)
    }
  })

  it('does not use the spaced, capitalised Solo Ledger product name', () => {
    // Lowercase-hyphen "solo-ledger" remains allowed for inherited-value references.
    expect(
      deployDoc.includes('Solo Ledger'),
      'DEPLOY.md must not use the spaced, capitalised product name "Solo Ledger"',
    ).toBe(false)
  })
})
