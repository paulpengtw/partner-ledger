import { describe, expect, it } from 'vitest'
import { loadWorkflow } from './workflows'

const { doc } = loadWorkflow('deploy-apps-script.yml')

// The partner-ledger ids, as documented in DEPLOY.md and
// docs/partner-ledger-spec.md. This fork shipped with the inherited
// solo-ledger values in place once already.
const SCRIPT_ID = '1ILn1uVrpUk-SO7SyCaGxG20UOVj4eqVNKYrSmB-uGKV4_tbbSQ1YF5Ko'
const DEPLOYMENT_ID =
  'AKfycbzsK256P__IeaEpVzaFwnLfvKk4RVBQTZ-vpHIUG0l71bTD-7zrG9y842SyI_Ku52hC'

const [deployJob] = Object.values(doc.jobs) as any[]
const runSteps = (deployJob.steps as any[]).filter(
  (step: any) => typeof step.run === 'string',
)
const claspPushIndex = runSteps.findIndex((step: any) =>
  /clasp@[\d.]+ push/.test(step.run as string),
)
const claspDeployIndex = runSteps.findIndex((step: any) =>
  /clasp@[\d.]+ deploy/.test(step.run as string),
)

describe('.github/workflows/deploy-apps-script.yml', () => {
  it('is gated on the Apps Script sources rather than every push to main', () => {
    // ADR 0004: each deploy mints an immutable version and the platform
    // caps a project at ~200, so frontend-only pushes must not consume one.
    expect(doc.on.push.branches).toEqual(['main'])
    expect(doc.on.push.paths).toContain('apps-script/**')
  })

  it('pushes the source before it repoints the deployment', () => {
    // Pushing alone does not change what /exec serves.
    expect(claspPushIndex).toBeGreaterThanOrEqual(0)
    expect(claspDeployIndex).toBeGreaterThan(claspPushIndex)
  })

  it('repoints the pinned deployment id instead of creating a new deployment', () => {
    // A new deployment would mint a new /exec URL, which the web app does
    // not know about.
    expect(runSteps[claspDeployIndex].run).toContain('-i "$DEPLOYMENT_ID"')
  })

  it('carries the partner-ledger ids, not the inherited solo-ledger ones', () => {
    expect(deployJob.env.SCRIPT_ID).toBe(SCRIPT_ID)
    expect(deployJob.env.DEPLOYMENT_ID).toBe(DEPLOYMENT_ID)
  })

  it('grants only contents: read at the top-level permissions', () => {
    expect(doc.permissions).toEqual({ contents: 'read' })
  })

  it('queues concurrent runs rather than cancelling them mid-deploy', () => {
    // Cancelling between push and deploy leaves the source pushed but the
    // deployment still serving the old version.
    expect(String(doc.concurrency['cancel-in-progress'])).toBe('false')
  })
})
