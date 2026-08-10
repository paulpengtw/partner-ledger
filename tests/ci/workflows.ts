import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

export function workflowsDirectory(): string {
  return fileURLToPath(new URL('../../.github/workflows', import.meta.url))
}

export function listWorkflows(): string[] {
  const directory = workflowsDirectory()
  if (!existsSync(directory)) {
    throw new Error(`no workflows directory at ${directory}`)
  }
  return readdirSync(directory)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
}
