import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export function listTracked(...patterns: string[]): string[] {
  const stdout = execFileSync('git', ['ls-files', '-z', '--', ...patterns], {
    cwd: repoRoot,
    encoding: 'utf-8',
  })
  return stdout.split('\0').filter(Boolean).sort()
}

export function listMarkdownDocs(): string[] {
  return listTracked('*.md')
}

export function readTracked(path: string): string {
  return readFileSync(new URL(path, new URL('../../', import.meta.url)), 'utf-8')
}

/**
 * The lines that carry a file's content: trimmed, blanks dropped. Whitespace
 * and blank-line churn is not what a wholesale clobber looks like, so it is
 * not what the copy detector should be sensitive to.
 */
export function significantLines(source: string): string[] {
  return source
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

/**
 * Fraction of `subject`'s distinct lines that also appear in `other`. Distinct
 * rather than positional so a copy is still recognised after lines are added,
 * removed, or reordered.
 */
export function lineOverlap(subject: string, other: string): number {
  const subjectLines = new Set(significantLines(subject))
  if (subjectLines.size === 0) return 0

  const otherLines = new Set(significantLines(other))
  let shared = 0
  for (const line of subjectLines) {
    if (otherLines.has(line)) shared += 1
  }
  return shared / subjectLines.size
}

export type Overlap = { path: string; ratio: number }

/** The tracked file `path` most resembles, ignoring itself. */
export function closestTrackedFile(path: string): Overlap {
  const source = readTracked(path)
  let closest: Overlap = { path: '', ratio: 0 }

  for (const candidate of listTracked()) {
    if (candidate === path) continue
    let other: string
    try {
      other = readTracked(candidate)
    } catch {
      continue // binary or unreadable; not a plausible clobber source
    }
    const ratio = lineOverlap(source, other)
    if (ratio > closest.ratio) closest = { path: candidate, ratio }
  }

  return closest
}

export type AvoidSplit = { defining: string; avoiding: string }

/**
 * Separates a domain doc's own `_Avoid_:` notes from the text that defines
 * terms. An `_Avoid_:` note runs to the end of its paragraph, so a wrapped
 * note stays a note. Lets a guard ask "is this term defined here" separately
 * from "is this term listed as dead here" — the doc says both, in one entry.
 */
export function splitAvoidNotes(doc: string): AvoidSplit {
  const defining: string[] = []
  const avoiding: string[] = []
  let inAvoidNote = false

  for (const raw of doc.split('\n')) {
    const line = raw.trim()
    if (line === '') {
      inAvoidNote = false
      continue
    }
    if (/^_Avoid_:/.test(line)) inAvoidNote = true
    ;(inAvoidNote ? avoiding : defining).push(line)
  }

  return { defining: defining.join('\n'), avoiding: avoiding.join('\n') }
}

/** The single-quoted entries of a named array/Set literal in a source file. */
export function extractQuotedList(source: string, anchor: RegExp): string[] {
  const body = anchor.exec(source)?.[1]
  if (body === undefined) throw new Error(`no declaration matching ${anchor}`)
  return [...body.matchAll(/'([^']+)'/g)].flatMap(match =>
    match[1] === undefined ? [] : [match[1]],
  )
}
