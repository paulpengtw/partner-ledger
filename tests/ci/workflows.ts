import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export type LoadedWorkflow = {
  path: string
  raw: string
  doc: any
}

export function workflowPath(name: string): string {
  return fileURLToPath(
    new URL(`../../.github/workflows/${name}`, import.meta.url),
  )
}

export function loadWorkflow(name: string): LoadedWorkflow {
  const path = workflowPath(name)
  if (!existsSync(path)) {
    throw new Error(`workflow not found at ${path}`)
  }
  const raw = readFileSync(path, 'utf-8')
  return { path, raw, doc: parse(raw) }
}
