import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadGasFunctionsWithFakeGas,
  type FakeGasHarness,
} from './helpers/gas'

const fixedNow = new Date('2026-08-09T00:00:00.000Z')

describe('weekly backups', () => {
  let harness: FakeGasHarness

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    harness = loadGasFunctionsWithFakeGas()
    harness.setupSpreadsheet()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a dated spreadsheet copy and stores the backup folder id', () => {
    const result = harness.weeklyBackup()
    const folderId = harness.peekScriptProperty('LEDGER_BACKUP_FOLDER_ID')

    expect(folderId).toBeTruthy()
    const folder = harness.drive.getFolderById(folderId as string)
    const activeFiles = folder.allFiles().filter(file => !file.isTrashed())
    const backupPrefix = `${harness.spreadsheet.getName()} backup `

    expect(result).toMatchObject({
      ok: true,
      name: expect.stringMatching(
        new RegExp(`^${backupPrefix}20260809-`),
      ),
      pruned: [],
    })
    expect(activeFiles).toHaveLength(1)
    expect(activeFiles[0]?.getId()).toBe(result.file_id)
    expect(activeFiles[0]?.getName()).toBe(result.name)
  })

  it('prunes backups to the newest twelve files', () => {
    const folder = harness.drive.createFolder('weekly backups')
    const backupPrefix = `${harness.spreadsheet.getName()} backup `
    const copies = []

    for (let day = 1; day <= 15; day += 1) {
      copies.push(
        harness.drive.createFile(
          `${backupPrefix}${String(day).padStart(2, '0')}`,
          new Date(`2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`),
          folder,
        ),
      )
    }

    harness.pruneBackups_(folder, backupPrefix, harness.spreadsheetId)

    expect(
      folder
        .allFiles()
        .filter(file => !file.isTrashed())
        .map(file => file.getName()),
    ).toEqual(
      Array.from(
        { length: 12 },
        (_unused, index) => `${backupPrefix}${String(index + 4).padStart(2, '0')}`,
      ),
    )
    expect(copies.filter(file => file.isTrashed()).map(file => file.getName())).toEqual([
      `${backupPrefix}01`,
      `${backupPrefix}02`,
      `${backupPrefix}03`,
    ])
  })

  it('installs only the weekly backup trigger', () => {
    harness.installWeeklyTriggers()
    harness.installWeeklyTriggers()

    expect(harness.triggers).toHaveLength(1)
    expect(harness.triggers.map(trigger => trigger.handler)).toEqual([
      'weeklyBackup',
    ])
    expect(harness.triggers[0]).toMatchObject({
      weekDay: 'MONDAY',
      hour: 8,
    })
  })
})
