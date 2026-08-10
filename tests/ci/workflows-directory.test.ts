import { describe, expect, it } from 'vitest'
import { listWorkflows, loadWorkflow } from './workflows'

const names = listWorkflows()

describe('.github/workflows/', () => {
  it('discovers the workflow files on disk', () => {
    // An empty directory must fail here rather than let the guard below
    // pass vacuously with nothing to check.
    expect(names.length).toBeGreaterThan(0)
  })

  // Deliberately shallow: this answers "is this a workflow at all", not
  // "is this workflow correct". Per-workflow correctness lives in the
  // individual tests alongside this one.
  it.each(names)(
    '%s parses as YAML and carries the top-level keys a workflow requires',
    name => {
      const { doc } = loadWorkflow(name)

      expect(typeof doc).toBe('object')
      expect(doc).not.toBeNull()
      expect(doc.on).toBeDefined()
      expect(Object.keys(doc.jobs ?? {}).length).toBeGreaterThan(0)
    },
  )
})
