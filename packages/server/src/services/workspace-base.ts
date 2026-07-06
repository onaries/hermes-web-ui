import { stat } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import { readAppConfig, normalizeWorkspaceConfig, type WorkspaceConfig } from './app-config'

export type WorkspaceBaseSource = 'env' | 'app' | 'home'

export interface WorkspaceBaseInfo {
  configuredBase: string
  effectiveBase: string
  source: WorkspaceBaseSource
}

export interface WorkspaceConfigResponse extends WorkspaceConfig {
  effective_base: string
  source: WorkspaceBaseSource
  env_override?: string
}

function envWorkspaceBase(): string {
  return process.env.WORKSPACE_BASE?.trim() || ''
}

function normalizeBasePath(value: string): string {
  return resolve(value)
}

export async function getWorkspaceBaseInfo(): Promise<WorkspaceBaseInfo> {
  const envBase = envWorkspaceBase()
  if (envBase) {
    const effectiveBase = normalizeBasePath(envBase)
    return { configuredBase: effectiveBase, effectiveBase, source: 'env' }
  }

  const appConfig = normalizeWorkspaceConfig((await readAppConfig()).workspace)
  if (appConfig.base) {
    const effectiveBase = normalizeBasePath(appConfig.base)
    return { configuredBase: effectiveBase, effectiveBase, source: 'app' }
  }

  const effectiveBase = homedir()
  return { configuredBase: '', effectiveBase, source: 'home' }
}

export async function getConfiguredWorkspaceBase(): Promise<string> {
  return (await getWorkspaceBaseInfo()).configuredBase
}

export async function getEffectiveWorkspaceBase(): Promise<string> {
  return (await getWorkspaceBaseInfo()).effectiveBase
}

export async function getWorkspaceConfigResponse(): Promise<WorkspaceConfigResponse> {
  const appConfig = normalizeWorkspaceConfig((await readAppConfig()).workspace)
  const info = await getWorkspaceBaseInfo()
  const envOverride = envWorkspaceBase()
  return {
    ...appConfig,
    effective_base: info.effectiveBase,
    source: info.source,
    ...(envOverride ? { env_override: normalizeBasePath(envOverride) } : {}),
  }
}

export async function normalizeWorkspaceConfigInput(values: Record<string, any>): Promise<WorkspaceConfig> {
  const rawBase = typeof values.base === 'string' ? values.base.trim() : ''
  if (!rawBase) return {}
  if (!isAbsolute(rawBase)) {
    throw Object.assign(new Error('Workspace base must be an absolute path'), { status: 400 })
  }

  const base = normalizeBasePath(rawBase)
  let info
  try {
    info = await stat(base)
  } catch {
    throw Object.assign(new Error('Workspace base path not found'), { status: 400 })
  }
  if (!info.isDirectory()) {
    throw Object.assign(new Error('Workspace base must be a directory'), { status: 400 })
  }
  return { base }
}

export async function useWindowsDriveWorkspaceMode(): Promise<boolean> {
  return process.platform === 'win32' && !(await getConfiguredWorkspaceBase())
}
