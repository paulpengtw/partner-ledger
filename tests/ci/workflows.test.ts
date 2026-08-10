import { describe, expect, it } from 'vitest'
import { loadWorkflow } from './workflows'

describe('loadWorkflow', () => {
  it('throws one error naming the path when the workflow is not there', () => {
    expect(() => loadWorkflow('no-such-workflow.yml')).toThrowError(
      /workflow not found at .*\.github\/workflows\/no-such-workflow\.yml/,
    )
  })

  it('returns the raw text and the parsed document of a workflow that exists', () => {
    const { raw, doc } = loadWorkflow('ci.yml')

    expect(raw).toContain('name: CI')
    expect(doc.name).toBe('CI')
  })
})
