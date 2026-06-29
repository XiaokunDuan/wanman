import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import logUpdate from 'log-update'
import type { RunOptions } from './execution-session.js'
import { runLocalSupervisorSession } from './local-supervisor-session.js'
import {
  createTakeoverCoordinationBackend,
  ensureMissionBoard,
  listDevWorkers,
  maybeNudgeMissionControl,
  maybeScaleWorkforce,
  type MissionNudgeState,
  planDynamicClone,
  sendKickoffSteer,
} from './takeover-coordination.js'
import {
  type RuntimeArtifact,
  type RuntimeCapsule,
  type RuntimeClient,
  type RuntimeHealth,
  type RuntimeInitiative,
  type TaskInfo,
} from './runtime-client.js'
import {
  type GeneratedAgentConfig,
  type ProjectIntent,
  type ProjectProfile,
  type TakeoverRuntimePaths,
  writeTakeoverOverlayFiles,
} from './takeover-project.js'
import { formatDashboard, renderDashboard, type DashboardState } from './tui/dashboard.js'

const MAX_DEV_WORKERS = 3
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
const MAX_RUNTIME_ERROR_RETRIES = 2
const FALLBACK_BACKLOG_COMPLETED_CEO_RUNS = 2
const EXECUTION_WATCHDOG_STALLED_POLLS = 6
const EXECUTION_WATCHDOG_COOLDOWN_MS = 90_000

type CheckState = 'success' | 'failure' | 'pending' | 'none' | 'unknown'

export interface LocalObservationState {
  health: RuntimeHealth
  tasks: TaskInfo[]
  initiatives: RuntimeInitiative[]
  capsules: RuntimeCapsule[]
  artifacts: RuntimeArtifact[]
  logs: string[]
  activeBranch?: string
  branchAhead: number
  branchBehind: number
  baseAhead: number
  baseBehind: number
  hasUpstream: boolean
  prUrl?: string
  prState?: string
  prCheckState: CheckState
  headSha?: string
  baseSha?: string
  headCiState: CheckState
  baseCiState: CheckState
  modifiedFiles: string[]
}

interface LocalGitState {
  activeBranch?: string
  branchAhead: number
  branchBehind: number
  baseAhead: number
  baseBehind: number
  hasUpstream: boolean
  modifiedFiles: string[]
  headSha?: string
  baseSha?: string
}

interface LocalPullRequestState {
  url?: string
  state?: string
  checkState: CheckState
}

interface LocalPrNudgeState {
  lastSignature?: string
  lastSentAt?: number
}

interface RuntimeErrorRecord {
  agent: string
  detail: string
  count: number
}

interface LocalToolActivity {
  agent: string
  tool: string
  summary?: string
}

export interface LocalExecutionWatchdogState {
  stagnantPollsByAgent: Record<string, number>
  stagnantSinceByAgent: Record<string, number>
  lastToolByAgent: Record<string, LocalToolActivity>
  lastToolAtByAgent: Record<string, number>
  lastSignature?: string
  lastSentAt?: number
}

export interface RuntimeErrorGateState {
  seenLogLines: Set<string>
  byAgent: Record<string, RuntimeErrorRecord>
}

export interface RuntimeErrorGateResult {
  failed: boolean
  retries: RuntimeErrorRecord[]
  failure?: RuntimeErrorRecord
}

type LocalMissionNudgeState = MissionNudgeState

interface LocalFallbackBacklogState {
  seeded?: boolean
}

/** @internal exported for testing */
export function warnLocalEnvironment(profile: ProjectProfile, worktreePath: string): void {
  const warnings: string[] = []

  try {
    execSync('command -v node', { stdio: 'ignore', shell: '/bin/bash' })
  } catch {
    warnings.push('`node` is not available in the current environment')
  }

  if (profile.packageManagers.includes('pnpm')) {
    try {
      execSync('command -v pnpm', { stdio: 'ignore', shell: '/bin/bash' })
    } catch {
      warnings.push('project expects `pnpm`, but it is not available in PATH')
    }
  }

  const hostCli = path.join(profile.path, 'packages/cli/dist/index.js')
  const hostRuntime = path.join(profile.path, 'packages/runtime/dist/entrypoint.js')
  if (!fs.existsSync(hostCli)) warnings.push(`missing built CLI entrypoint: ${hostCli}`)
  if (!fs.existsSync(hostRuntime)) warnings.push(`missing built runtime entrypoint: ${hostRuntime}`)

  const hostNodeModules = path.join(profile.path, 'node_modules')
  const worktreeNodeModules = path.join(worktreePath, 'node_modules')
  if (!fs.existsSync(hostNodeModules) && !fs.existsSync(worktreeNodeModules)) {
    warnings.push('no node_modules found in host repo or worktree; agent verification commands may fail')
  }

  if (warnings.length === 0) return

  console.log('  [local] Environment warnings:')
  for (const warning of warnings) {
    console.log(`    - ${warning}`)
  }
  console.log('  [local] Continuing without reinstalling dependencies. Local mode reuses the host environment.')
}

function snapshotTasks(tasks: Array<{ id: string; status: string; assignee?: string; initiativeId?: string; capsuleId?: string }>): string {
  return JSON.stringify(tasks.map(task => ({
    id: task.id,
    status: task.status,
    initiativeId: task.initiativeId,
    capsuleId: task.capsuleId,
  })))
}

function snapshotBoard<T extends { id: string; status: string }>(items: T[]): string {
  return JSON.stringify(items.map(item => ({
    id: item.id,
    status: item.status,
  })))
}

function snapshotArtifacts(artifacts: RuntimeArtifact[]): string {
  return JSON.stringify(
    artifacts
      .map(artifact => ({
        agent: artifact.agent,
        kind: artifact.kind,
        cnt: artifact.cnt,
      }))
      .sort((left, right) => `${left.agent}:${left.kind}`.localeCompare(`${right.agent}:${right.kind}`)),
  )
}

function snapshotWorktree(state: Pick<LocalObservationState, 'activeBranch' | 'branchAhead' | 'hasUpstream' | 'prUrl' | 'modifiedFiles'>): string {
  return JSON.stringify({
    activeBranch: state.activeBranch,
    branchAhead: state.branchAhead,
    hasUpstream: state.hasUpstream,
    prUrl: state.prUrl,
    modifiedFiles: [...state.modifiedFiles].sort(),
  })
}

function parseRuntimeErrorLine(line: string): { agent: string; detail: string } | null {
  if (!line.includes('runtime_error')) return null
  try {
    const parsed = JSON.parse(line) as { msg?: unknown; agent?: unknown }
    if (parsed.msg === 'runtime_error') {
      return {
        agent: typeof parsed.agent === 'string' && parsed.agent.trim() ? parsed.agent : 'unknown',
        detail: line.slice(0, 500),
      }
    }
  } catch {
    // Fall through to text log parsing.
  }
  const agentMatch = line.match(/\(([^)]+)\)/) ?? line.match(/agent[=:]([A-Za-z0-9_-]+)/)
  const agent = agentMatch?.[1]?.trim() || 'unknown'
  return { agent, detail: line.slice(0, 500) }
}

/** @internal exported for testing */
export function createRuntimeErrorGateState(): RuntimeErrorGateState {
  return { seenLogLines: new Set(), byAgent: {} }
}

/** @internal exported for testing */
export function evaluateRuntimeErrorGate(
  state: RuntimeErrorGateState,
  logLines: string[],
  maxRetries = MAX_RUNTIME_ERROR_RETRIES,
): RuntimeErrorGateResult {
  const retries: RuntimeErrorRecord[] = []
  for (const line of logLines) {
    if (state.seenLogLines.has(line)) continue
    state.seenLogLines.add(line)
    const parsed = parseRuntimeErrorLine(line)
    if (!parsed) continue

    const current = state.byAgent[parsed.agent] ?? { agent: parsed.agent, detail: parsed.detail, count: 0 }
    current.count += 1
    current.detail = parsed.detail
    state.byAgent[parsed.agent] = current
    if (current.count <= maxRetries) retries.push({ ...current })
    else return { failed: true, retries, failure: { ...current } }
  }
  return { failed: false, retries }
}

function summarizeChecks(checks: Array<Record<string, unknown>>): CheckState {
  if (checks.length === 0) return 'none'

  let sawCompleted = false
  for (const check of checks) {
    const status = String(check['status'] ?? '').toLowerCase()
    const conclusion = String(check['conclusion'] ?? '').toLowerCase()
    const state = String(check['state'] ?? '').toLowerCase()
    if (state) {
      if (state === 'success') {
        sawCompleted = true
        continue
      }
      if (state === 'pending' || state === 'expected') return 'pending'
      return 'failure'
    }
    if (status && status !== 'completed') return 'pending'
    if (!conclusion) return 'pending'
    sawCompleted = true
    if (!SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion)) return 'failure'
  }

  return sawCompleted ? 'success' : 'pending'
}

function summarizeRuns(runs: Array<Record<string, unknown>>): CheckState {
  if (runs.length === 0) return 'none'

  let sawCompleted = false
  for (const run of runs) {
    const status = String(run['status'] ?? '').toLowerCase()
    const conclusion = String(run['conclusion'] ?? '').toLowerCase()
    if (status && status !== 'completed') return 'pending'
    if (!conclusion) return 'pending'
    sawCompleted = true
    if (!SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion)) return 'failure'
  }

  return sawCompleted ? 'success' : 'pending'
}

export function parseLocalGitStatus(raw: string): LocalGitState {
  const state: LocalGitState = {
    activeBranch: undefined,
    branchAhead: 0,
    branchBehind: 0,
    baseAhead: 0,
    baseBehind: 0,
    hasUpstream: false,
    modifiedFiles: [],
    headSha: undefined,
    baseSha: undefined,
  }

  const seenFiles = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue

    if (line.startsWith('# branch.head ')) {
      const branch = line.slice('# branch.head '.length).trim()
      state.activeBranch = branch && branch !== '(detached)' ? branch : undefined
      continue
    }

    if (line.startsWith('# branch.upstream ')) {
      state.hasUpstream = true
      continue
    }

    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (match) {
        state.branchAhead = Number.parseInt(match[1] ?? '0', 10)
        state.branchBehind = Number.parseInt(match[2] ?? '0', 10)
      }
      continue
    }

    const changedPath = extractPorcelainPath(line)
    if (changedPath && !seenFiles.has(changedPath)) {
      seenFiles.add(changedPath)
      state.modifiedFiles.push(changedPath)
    }
  }

  return state
}

async function detectPullRequestState(worktreePath: string, branch?: string): Promise<LocalPullRequestState> {
  if (!branch) return { checkState: 'none' }
  try {
    const raw = execSync(`gh pr list --head ${JSON.stringify(branch)} --state all --json url,state,statusCheckRollup --limit 5`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (!raw) return { checkState: 'none' }
    const parsed = JSON.parse(raw) as Array<{ url?: string; state?: string; statusCheckRollup?: Array<Record<string, unknown>> }>
    const open = parsed.find(pr => String(pr.state ?? '').toUpperCase() === 'OPEN')
    const selected = open ?? parsed[0]
    return {
      url: selected?.url,
      state: selected?.state,
      checkState: summarizeChecks(selected?.statusCheckRollup ?? []),
    }
  } catch {
    return { checkState: 'unknown' }
  }
}

function extractPorcelainPath(line: string): string | undefined {
  if (line.startsWith('? ') || line.startsWith('! ')) {
    return line.slice(2).trim() || undefined
  }

  const ordinary = line.match(/^1 [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/)
  if (ordinary) return ordinary[1]?.trim() || undefined

  const renamed = line.match(/^2 [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/)
  if (renamed) {
    return renamed[1]?.split('\t')[0]?.trim() || undefined
  }

  const unmerged = line.match(/^u [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/)
  if (unmerged) return unmerged[1]?.trim() || undefined

  return undefined
}

async function readLocalGitState(worktreePath: string): Promise<LocalGitState> {
  try {
    const raw = execSync('git status --porcelain=v2 --branch --untracked-files=all', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state = parseLocalGitStatus(raw)
    state.headSha = readGitRef(worktreePath, 'HEAD')
    state.baseSha = readGitRef(worktreePath, 'origin/main')
    if (state.baseSha && state.headSha) {
      const divergence = readGitDivergence(worktreePath, 'origin/main', 'HEAD')
      state.baseBehind = divergence.leftOnly
      state.baseAhead = divergence.rightOnly
    }
    return state
  } catch {
    return {
      activeBranch: undefined,
      branchAhead: 0,
      branchBehind: 0,
      baseAhead: 0,
      baseBehind: 0,
      hasUpstream: false,
      modifiedFiles: [],
      headSha: undefined,
      baseSha: undefined,
    }
  }
}

function readGitRef(worktreePath: string, ref: string): string | undefined {
  try {
    return execSync(`git rev-parse --verify ${JSON.stringify(ref)}`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || undefined
  } catch {
    return undefined
  }
}

function readCurrentBranch(worktreePath: string): string | undefined {
  try {
    return execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined
  } catch {
    return undefined
  }
}

function isCleanWorktree(worktreePath: string): boolean {
  try {
    return execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === ''
  } catch {
    return false
  }
}

/** @internal exported for testing */
export function ensureLocalCapsuleBranch(
  worktreePath: string,
  branch: string,
  opts: { log?: (message: string) => void } = {},
): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
    opts.log?.(`capsule_branch_checkout_skipped branch=${branch} reason=invalid`)
    return false
  }
  if (readCurrentBranch(worktreePath) === branch) return false
  if (!isCleanWorktree(worktreePath)) {
    opts.log?.(`capsule_branch_checkout_skipped branch=${branch} reason=dirty_worktree`)
    return false
  }

  try {
    if (readGitRef(worktreePath, `refs/heads/${branch}`)) {
      execFileSync('git', ['checkout', branch], { cwd: worktreePath, stdio: 'ignore' })
    } else {
      execFileSync('git', ['checkout', '-b', branch], { cwd: worktreePath, stdio: 'ignore' })
    }
  } catch (err) {
    opts.log?.(`capsule_branch_checkout_failed branch=${branch} reason=${err instanceof Error ? err.message : String(err)}`)
    return false
  }

  opts.log?.(`capsule_branch_checked_out branch=${branch}`)
  return true
}

function readGitDivergence(worktreePath: string, leftRef: string, rightRef: string): { leftOnly: number; rightOnly: number } {
  try {
    const raw = execSync(`git rev-list --left-right --count ${JSON.stringify(leftRef)}...${JSON.stringify(rightRef)}`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const [left, right] = raw.split(/\s+/)
    return {
      leftOnly: Number.parseInt(left ?? '0', 10) || 0,
      rightOnly: Number.parseInt(right ?? '0', 10) || 0,
    }
  } catch {
    return { leftOnly: 0, rightOnly: 0 }
  }
}

function detectCommitCiState(worktreePath: string, sha?: string): CheckState {
  if (!sha) return 'unknown'
  try {
    const raw = execSync(`gh run list --commit ${JSON.stringify(sha)} --limit 20 --json status,conclusion`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (!raw) return 'none'
    return summarizeRuns(JSON.parse(raw) as Array<Record<string, unknown>>)
  } catch {
    return 'unknown'
  }
}

/** @internal exported for testing */
export function buildLocalDashboardState(
  goal: string,
  observedLoops: number,
  maxLoops: number,
  startedAt: number,
  state: LocalObservationState,
): DashboardState {
  return {
    goal,
    loop: Math.max(observedLoops, 1),
    maxLoops: Math.max(maxLoops, 1),
    elapsed: Date.now() - startedAt,
    brainName: state.prUrl ? `PR: ${state.prUrl}` : state.activeBranch,
    agents: state.health.agents.map(agent => ({
      name: agent.name,
      state: agent.state,
      lifecycle: agent.lifecycle,
    })),
    tasks: state.tasks,
    logs: state.logs,
    artifacts: state.artifacts,
  }
}

/** @internal exported for testing */
export function appendLogLines(buffer: string[], lines: string[], maxLines = 200): void {
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    buffer.push(trimmed)
  }
  if (buffer.length > maxLines) buffer.splice(0, buffer.length - maxLines)
}

/** @internal exported for testing */
export async function collectLocalObservationState(
  runtime: RuntimeClient,
  worktreePath: string,
  logLines: string[],
): Promise<LocalObservationState> {
  const health = await runtime.getHealth()
  const tasks = await runtime.listTasks().catch(() => [])
  const initiatives = await runtime.listInitiatives().catch(() => [])
  const capsules = await runtime.listCapsules().catch(() => [])
  const artifacts = await runtime.listArtifacts().catch(() => [])
  const gitState = await readLocalGitState(worktreePath)
  const pr = await detectPullRequestState(worktreePath, gitState.activeBranch)
  const headCiState = detectCommitCiState(worktreePath, gitState.headSha)
  const baseCiState = gitState.baseSha === gitState.headSha
    ? headCiState
    : detectCommitCiState(worktreePath, gitState.baseSha)
  return {
    health,
    tasks,
    initiatives,
    capsules,
    artifacts,
    logs: logLines.slice(-50),
    activeBranch: gitState.activeBranch,
    branchAhead: gitState.branchAhead,
    branchBehind: gitState.branchBehind,
    baseAhead: gitState.baseAhead,
    baseBehind: gitState.baseBehind,
    hasUpstream: gitState.hasUpstream,
    prUrl: String(pr.state ?? '').toUpperCase() === 'OPEN' ? pr.url : undefined,
    prState: pr.state,
    prCheckState: pr.checkState,
    headSha: gitState.headSha,
    baseSha: gitState.baseSha,
    headCiState,
    baseCiState,
    modifiedFiles: gitState.modifiedFiles,
  }
}

export function hasLocalProgress(previous: LocalObservationState, current: LocalObservationState): boolean {
  if (snapshotTasks(previous.tasks) !== snapshotTasks(current.tasks)) return true
  if (snapshotBoard(previous.initiatives) !== snapshotBoard(current.initiatives)) return true
  if (snapshotBoard(previous.capsules) !== snapshotBoard(current.capsules)) return true
  if (snapshotArtifacts(previous.artifacts) !== snapshotArtifacts(current.artifacts)) return true
  return snapshotWorktree(previous) !== snapshotWorktree(current)
}

function slugifyBranchPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'project'
}

function createLoggedLocalCoordinationBackend(runtime: RuntimeClient) {
  return createTakeoverCoordinationBackend(runtime, {
    log: message => {
      console.log(`  [local] ${message}`)
    },
  })
}

function isImplementationTask(task: TaskInfo): boolean {
  const title = task.title.toLowerCase()
  return task.capsuleId !== undefined
    || /(implement|build|fix|add|update|refactor|test|game|ui|feature)/.test(title)
}

function isDevWorker(assignee?: string): boolean {
  return assignee === 'dev' || /^dev-\d+$/.test(assignee ?? '')
}

function buildDefaultTakeoverPaths(intent: ProjectIntent): string[] {
  return [
    ...new Set([
      ...intent.codeRoots,
      'package.json',
      'tsconfig.json',
      ...intent.canonicalDocs
        .map(doc => doc.path)
        .filter(docPath => /spec|roadmap|plan|requirements|prd/i.test(docPath)),
    ].filter(Boolean)),
  ]
}

function extractTaskPaths(task: TaskInfo, intent: ProjectIntent): string[] {
  const paths = [
    ...(task.scope?.paths ?? []),
    ...buildDefaultTakeoverPaths(intent),
  ]
  return [...new Set(paths.filter(Boolean))]
}

/** @internal exported for testing */
export async function recoverOrphanLocalTasks(
  runtime: Pick<RuntimeClient, 'updateTask' | 'sendMessage'>,
  state: LocalObservationState,
  opts: { assignee?: string; log?: (message: string) => void } = {},
): Promise<boolean> {
  const assignee = opts.assignee ?? 'dev'
  const knownAgents = new Set(state.health.agents.map(agent => agent.name))
  if (!knownAgents.has(assignee)) return false

  const orphanTasks = state.tasks.filter(task => (
    task.status === 'pending'
    && !task.assignee
    && isImplementationTask(task)
  ))
  if (orphanTasks.length === 0) return false

  for (const task of orphanTasks) {
    await runtime.updateTask({
      id: task.id,
      status: 'assigned',
      assignee,
      agent: 'takeover-orphan-recovery',
    })
    await runtime.sendMessage({
      from: 'takeover-orphan-recovery',
      to: assignee,
      type: 'message',
      priority: 'steer',
      payload: [
        `Recovered orphan task ${task.id.slice(0, 8)}: "${task.title}".`,
        `The task was pending without an assignee, so local takeover assigned it to ${assignee}.`,
        `Run \`wanman task list --assignee ${assignee}\`, mark it in_progress, implement within the task scope, verify, then mark it done.`,
      ].join(' '),
    })
    opts.log?.(`orphan_task_recovered task=${task.id.slice(0, 8)} status=pending assignee=${assignee}`)
  }

  return true
}

/** @internal exported for testing */
export async function seedLocalFallbackBacklog(
  runtime: Pick<RuntimeClient, 'createTask' | 'createCapsule' | 'updateTask' | 'sendMessage'>,
  state: LocalObservationState,
  intent: ProjectIntent,
  worktreePath: string,
  opts: { seedState?: LocalFallbackBacklogState; log?: (message: string) => void } = {},
): Promise<boolean> {
  const seedState = opts.seedState ?? {}
  if (seedState.seeded) return false
  if (state.tasks.length > 0 || state.capsules.length > 0) return false
  const completedCeoRuns = state.health.runtime?.completedRunsByAgent?.['ceo'] ?? 0
  if (completedCeoRuns < FALLBACK_BACKLOG_COMPLETED_CEO_RUNS) return false

  const devAvailable = state.health.agents.some(agent => agent.name === 'dev')
  if (!devAvailable) return false
  const initiative = state.initiatives
    .filter(item => item.status === 'active')
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0]
  if (!initiative) return false

  const paths = buildDefaultTakeoverPaths(intent)
  const scopedPaths = paths.length > 0 ? paths : ['.']
  const baseCommit = state.headSha ?? readGitRef(worktreePath, 'HEAD') ?? 'HEAD'
  const branch = `wanman/${slugifyBranchPart(intent.projectName)}-playable-rts-lite`
  const title = `Implement playable RTS-lite command sandbox`
  const acceptance = [
    'Default page opens into the playable RTS-lite experience described in PROJECT_SPEC.md or the canonical project spec.',
    'Simulation/domain logic is separated enough for focused tests.',
    'Run pnpm install if needed, then pnpm build and pnpm test successfully before marking done.',
    'Do not commit .wanman artifacts.',
  ].join(' ')

  const task = await runtime.createTask({
    title,
    description: [
      `CEO produced no executable backlog after ${completedCeoRuns} completed run(s), so local takeover seeded this fallback task from the canonical project spec.`,
      `Implement the finite playable browser game for ${intent.projectName}: selection, movement, resources, production, combat, enemy pressure, win/loss, save/load, and verification tests.`,
    ].join(' '),
    priority: 1,
    scope: { paths: scopedPaths },
    initiativeId: initiative.id,
    subsystem: 'rts-lite-game',
    scopeType: 'mixed',
    executionProfile: 'implementation',
    agent: 'takeover-fallback-backlog',
  })
  const capsule = await runtime.createCapsule({
    goal: title,
    ownerAgent: 'dev',
    branch,
    baseCommit,
    allowedPaths: scopedPaths,
    acceptance,
    reviewer: 'cto',
    initiativeId: initiative.id,
    taskId: task.id,
    subsystem: 'rts-lite-game',
    scopeType: 'mixed',
    agent: 'takeover-fallback-backlog',
  })
  ensureLocalCapsuleBranch(worktreePath, branch, opts)
  await runtime.updateTask({
    id: task.id,
    status: 'assigned',
    assignee: 'dev',
    agent: 'takeover-fallback-backlog',
  })
  await runtime.sendMessage({
    from: 'takeover-fallback-backlog',
    to: 'dev',
    type: 'message',
    priority: 'steer',
    payload: [
      `Fallback backlog seeded task ${task.id.slice(0, 8)} and capsule ${capsule.id.slice(0, 8)} because CEO left the backlog empty.`,
      `Work on branch ${branch}, stay within allowed paths: ${scopedPaths.join(', ')}.`,
      acceptance,
    ].join(' '),
  })

  seedState.seeded = true
  opts.log?.(`fallback_backlog_seeded task=${task.id.slice(0, 8)} capsule=${capsule.id.slice(0, 8)} assignee=dev`)
  return true
}

/** @internal exported for testing */
export async function repairLocalCapsuleGaps(
  runtime: Pick<RuntimeClient, 'createCapsule' | 'updateTask' | 'sendMessage'>,
  state: LocalObservationState,
  intent: ProjectIntent,
  worktreePath: string,
  opts: { log?: (message: string) => void } = {},
): Promise<boolean> {
  const activeInitiative = state.initiatives
    .filter(item => item.status === 'active')
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))[0]
  if (!activeInitiative) return false

  const changedTasks = state.tasks.filter(task => (
    task.status !== 'done'
    && isDevWorker(task.assignee)
    && (!task.initiativeId || !task.capsuleId)
    && task.scopeType !== 'docs'
    && task.scopeType !== 'ops'
  ))
  if (changedTasks.length === 0) return false

  const baseCommit = state.headSha ?? readGitRef(worktreePath, 'HEAD') ?? 'HEAD'
  let changed = false
  for (const task of changedTasks) {
    const initiativeId = task.initiativeId ?? activeInitiative.id
    const ownerAgent = task.assignee ?? 'dev'
    const scopedPaths = extractTaskPaths(task, intent)
    const allowedPaths = scopedPaths.length > 0 ? scopedPaths : ['.']
    const branch = `wanman/${slugifyBranchPart(task.title)}`
    const acceptance = [
      `Complete task ${task.id.slice(0, 8)}: ${task.title}.`,
      'Stay within allowed paths.',
      'Run the closest available verification commands before marking done.',
      'Do not commit .wanman artifacts.',
    ].join(' ')
    const capsule = await runtime.createCapsule({
      goal: task.title,
      ownerAgent,
      branch,
      baseCommit,
      allowedPaths,
      acceptance,
      reviewer: 'cto',
      initiativeId,
      taskId: task.id,
      subsystem: task.subsystem ?? 'takeover-task',
      scopeType: task.scopeType ?? 'mixed',
      agent: 'takeover-capsule-repair',
    })
    ensureLocalCapsuleBranch(worktreePath, branch, opts)
    await runtime.updateTask({
      id: task.id,
      initiativeId,
      capsuleId: capsule.id,
      subsystem: task.subsystem ?? 'takeover-task',
      scopeType: task.scopeType ?? 'mixed',
      executionProfile: task.executionProfile ?? 'implementation',
      agent: 'takeover-capsule-repair',
    })
    await runtime.sendMessage({
      from: 'takeover-capsule-repair',
      to: ownerAgent,
      type: 'message',
      priority: 'steer',
      payload: [
        `Created and linked missing capsule ${capsule.id.slice(0, 8)} for task ${task.id.slice(0, 8)}.`,
        `Use branch ${branch} and stay within allowed paths: ${allowedPaths.join(', ')}.`,
        acceptance,
      ].join(' '),
    }).catch(() => undefined)
    opts.log?.(`capsule_gap_repaired task=${task.id.slice(0, 8)} capsule=${capsule.id.slice(0, 8)} assignee=${ownerAgent}`)
    changed = true
  }

  return changed
}

export function planLocalDynamicClone(state: LocalObservationState) {
  return planDynamicClone(
    state.tasks,
    listDevWorkers(state.health.agents.map(agent => agent.name)),
    MAX_DEV_WORKERS,
  )
}

async function maybeScaleLocalWorkforce(runtime: RuntimeClient, state: LocalObservationState): Promise<boolean> {
  return maybeScaleWorkforce(
    createLoggedLocalCoordinationBackend(runtime),
    state.tasks,
    listDevWorkers(state.health.agents.map(agent => agent.name)),
    'takeover-allocator',
    MAX_DEV_WORKERS,
  )
}

function isTakeoverFeatureBranch(branch?: string): boolean {
  return !!branch && /^(wanman|fix|feat|chore|docs)\//.test(branch)
}

function isPrimaryBranch(branch?: string): boolean {
  return branch === 'main' || branch === 'master'
}

function allTasksDone(state: LocalObservationState): boolean {
  return state.tasks.length > 0 && state.tasks.every(task => task.status === 'done')
}

function ciIsAcceptableForCompletion(state: CheckState): boolean {
  return state === 'success' || state === 'none'
}

/** @internal exported for testing */
export function getLocalCompletionReason(state: LocalObservationState): string | undefined {
  if (!allTasksDone(state)) return undefined
  if (state.modifiedFiles.length > 0) return undefined
  if (state.branchAhead > 0) return undefined
  if (state.branchBehind > 0) return undefined

  if (isPrimaryBranch(state.activeBranch)) {
    if (state.headCiState === 'success') {
      return `all tasks are done and ${state.activeBranch} is clean with green CI`
    }
    if (state.headCiState === 'none') {
      return `all tasks are done and ${state.activeBranch} is clean with no CI runs`
    }
  }

  if (state.prUrl) {
    if (state.baseSha && state.baseBehind > 0) return undefined
    return ciIsAcceptableForCompletion(state.prCheckState)
      ? `all tasks are done and PR branch is current with origin/main; PR checks ${state.prCheckState === 'success' ? 'passed' : 'are not configured'}: ${state.prUrl}`
      : undefined
  }

  if (state.baseSha && state.baseAhead === 0 && ciIsAcceptableForCompletion(state.baseCiState)) {
    return `all tasks are done and origin/main already contains the branch with ${state.baseCiState === 'success' ? 'green CI' : 'no CI runs'}`
  }

  return undefined
}

function shouldSuppressPrNudgeForStaleCompletedBranch(state: LocalObservationState): boolean {
  if (!allTasksDone(state)) return false
  if (state.modifiedFiles.length > 0 || state.branchAhead > 0) return false
  if (!isTakeoverFeatureBranch(state.activeBranch)) return false
  if (!state.baseSha || state.baseAhead > 0) return false
  if (state.prUrl && state.baseBehind > 0) return false
  if (state.prUrl && (state.prCheckState === 'failure' || state.prCheckState === 'unknown')) return false
  if (state.prUrl && state.tasks.some(task => task.status !== 'done')) return false
  if (state.prState && String(state.prState).toUpperCase() !== 'OPEN') return true
  return ciIsAcceptableForCompletion(state.baseCiState)
}

/** @internal exported for testing */
export function collectPrNudgeRecipients(state: LocalObservationState): string[] {
  const recipients = new Set<string>()
  for (const task of state.tasks) {
    if (!task.assignee) continue
    if (task.status === 'done') continue
    if (task.assignee === 'dev' || task.assignee === 'devops' || /^dev-\d+$/.test(task.assignee)) {
      recipients.add(task.assignee)
    }
  }
  recipients.add('ceo')
  return [...recipients]
}

/** @internal exported for testing */
export function buildPrNudgeSignature(state: LocalObservationState): string {
  return JSON.stringify({
    branch: state.activeBranch ?? null,
    branchAhead: state.branchAhead,
    branchBehind: state.branchBehind,
    baseAhead: state.baseAhead,
    baseBehind: state.baseBehind,
    hasUpstream: state.hasUpstream,
    modifiedFiles: state.modifiedFiles,
    prCheckState: state.prCheckState,
    prUrl: state.prUrl ?? null,
    recipients: collectPrNudgeRecipients(state),
    tasks: state.tasks
      .filter(task => task.assignee && (task.assignee === 'dev' || task.assignee === 'devops' || /^dev-\d+$/.test(task.assignee)))
      .map(task => ({ id: task.id, status: task.status, assignee: task.assignee })),
  })
}

async function maybeNudgeLocalMissionControl(
  runtime: RuntimeClient,
  state: LocalObservationState,
  intent: ProjectIntent,
  nudgeState: LocalMissionNudgeState,
): Promise<boolean> {
  return maybeNudgeMissionControl(
    createLoggedLocalCoordinationBackend(runtime),
    intent,
    state.tasks,
    nudgeState,
    'takeover-mission-control',
  )
}

/** @internal exported for testing */
export function createLocalExecutionWatchdogState(): LocalExecutionWatchdogState {
  return {
    stagnantPollsByAgent: {},
    stagnantSinceByAgent: {},
    lastToolByAgent: {},
    lastToolAtByAgent: {},
  }
}

function extractStructuredToolActivity(line: string): LocalToolActivity | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    if (parsed['scope'] !== 'agent-process') return undefined
    if (parsed['msg'] !== 'tool' && parsed['msg'] !== 'tool_call') return undefined
    const agent = typeof parsed['agent'] === 'string' ? parsed['agent'].trim() : ''
    const tool = typeof parsed['tool'] === 'string' ? parsed['tool'].trim() : ''
    if (!agent || !tool) return undefined
    const summary = typeof parsed['summary'] === 'string'
      ? parsed['summary'].trim().slice(0, 240)
      : typeof parsed['input'] === 'string'
        ? parsed['input'].trim().slice(0, 240)
        : undefined
    return summary ? { agent, tool, summary } : { agent, tool }
  } catch {
    return undefined
  }
}

function extractTextToolActivity(line: string): LocalToolActivity | undefined {
  const match = line.match(/agent-process tool(?:_call)? \(([^,]+), tool:([^)]+)\)(?::\s*(.+))?/)
  if (!match) return undefined
  const agent = match[1]?.trim()
  const tool = match[2]?.trim()
  if (!agent || !tool) return undefined
  const summary = match[3]?.trim().slice(0, 240)
  return summary ? { agent, tool, summary } : { agent, tool }
}

function extractLocalToolActivities(lines: string[]): LocalToolActivity[] {
  return lines.flatMap(line => {
    const structured = extractStructuredToolActivity(line)
    if (structured) return [structured]
    const text = extractTextToolActivity(line)
    return text ? [text] : []
  })
}

function isRunnableDevTask(task: TaskInfo): boolean {
  return task.status !== 'done' && isDevWorker(task.assignee) && isImplementationTask(task)
}

function currentRunnableDevTasks(state: LocalObservationState): TaskInfo[] {
  return state.tasks.filter(isRunnableDevTask)
}

function agentsWithOpenImplementationTasks(state: LocalObservationState): Set<string> {
  return new Set(currentRunnableDevTasks(state).map(task => task.assignee!).filter(Boolean))
}

function agentCanReceiveWatchdogNudge(state: LocalObservationState, agent: string): boolean {
  return state.health.agents.some(item => item.name === agent && (item.state === 'running' || item.state === 'idle'))
}

function buildExecutionWatchdogSignature(agent: string, state: LocalObservationState): string {
  return JSON.stringify({
    agent,
    activeBranch: state.activeBranch ?? null,
    modifiedFiles: state.modifiedFiles,
    tasks: currentRunnableDevTasks(state)
      .filter(task => task.assignee === agent)
      .map(task => ({ id: task.id, status: task.status, capsuleId: task.capsuleId })),
  })
}

/** @internal exported for testing */
export async function maybeNudgeStalledLocalExecution(
  runtime: Pick<RuntimeClient, 'sendMessage'>,
  previous: LocalObservationState,
  current: LocalObservationState,
  logLines: string[],
  watchdogState: LocalExecutionWatchdogState,
  opts: {
    stagnantPolls?: number
    cooldownMs?: number
    now?: number
    log?: (message: string) => void
  } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now()
  for (const activity of extractLocalToolActivities(logLines)) {
    watchdogState.lastToolByAgent[activity.agent] = activity
    watchdogState.lastToolAtByAgent[activity.agent] = now
  }

  const openAgents = agentsWithOpenImplementationTasks(current)
  for (const agent of Object.keys(watchdogState.stagnantPollsByAgent)) {
    if (!openAgents.has(agent)) {
      delete watchdogState.stagnantPollsByAgent[agent]
      delete watchdogState.stagnantSinceByAgent[agent]
    }
  }

  if (hasLocalProgress(previous, current)) {
    for (const agent of openAgents) {
      watchdogState.stagnantPollsByAgent[agent] = 0
      delete watchdogState.stagnantSinceByAgent[agent]
    }
    return false
  }

  const stalledPolls = opts.stagnantPolls ?? EXECUTION_WATCHDOG_STALLED_POLLS
  const cooldownMs = opts.cooldownMs ?? EXECUTION_WATCHDOG_COOLDOWN_MS
  const candidates = [...openAgents]
    .filter(agent => agentCanReceiveWatchdogNudge(current, agent))
    .filter(agent => watchdogState.lastToolByAgent[agent])
    .sort()

  for (const agent of candidates) {
    const nextPolls = (watchdogState.stagnantPollsByAgent[agent] ?? 0) + 1
    watchdogState.stagnantPollsByAgent[agent] = nextPolls
    const stagnantSince = watchdogState.stagnantSinceByAgent[agent] ?? now
    watchdogState.stagnantSinceByAgent[agent] = stagnantSince
    if ((watchdogState.lastToolAtByAgent[agent] ?? 0) < stagnantSince) continue
    if (nextPolls < stalledPolls) continue

    const signature = buildExecutionWatchdogSignature(agent, current)
    if (watchdogState.lastSignature === signature && now - (watchdogState.lastSentAt ?? 0) < cooldownMs) {
      continue
    }

    const lastTool = watchdogState.lastToolByAgent[agent]
    if (!lastTool) continue

    const agentTasks = currentRunnableDevTasks(current).filter(task => task.assignee === agent)
    const taskSummary = agentTasks
      .map(task => `${task.id.slice(0, 8)}:${task.status}:${task.title}`)
      .join('; ')
    const stalledSeconds = Math.max(1, Math.round((now - stagnantSince) / 1000))
    const changedFiles = current.modifiedFiles.length > 0
      ? `Current modified files: ${current.modifiedFiles.slice(0, 8).join(', ')}${current.modifiedFiles.length > 8 ? ', ...' : ''}.`
      : 'Current worktree still has no modified files.'
    const payload = [
      `Execution watchdog: ${agent} has shown tool activity but no observable task, artifact, or worktree progress for about ${stalledSeconds}s.`,
      `Last observed tool: ${lastTool.tool}${lastTool.summary ? ` (${lastTool.summary})` : ''}.`,
      `Branch: ${current.activeBranch ?? 'unknown'}. ${changedFiles}`,
      `Open assigned task(s): ${taskSummary || 'none'}.`,
      'Recover now: run `wanman task list --assignee ' + agent + '`, inspect the task, make a concrete code or test change in the worktree, run the closest verification, then mark the task done only after verified changes exist.',
      'If the task is blocked, mark it blocked with the exact blocker instead of continuing to run commands without changing the project.',
    ].join(' ')

    await runtime.sendMessage({
      from: 'takeover-execution-watchdog',
      to: agent,
      type: 'message',
      priority: 'steer',
      payload,
    }).catch(() => undefined)

    watchdogState.lastSignature = signature
    watchdogState.lastSentAt = now
    watchdogState.stagnantPollsByAgent[agent] = 0
    watchdogState.stagnantSinceByAgent[agent] = now
    opts.log?.(`execution_watchdog_nudged agent=${agent} polls=${nextPolls} tasks=${agentTasks.map(task => task.id.slice(0, 8)).join(',') || 'none'}`)
    return true
  }

  return false
}

/** @internal exported for testing */
export async function maybeNudgeLocalPrExecution(
  runtime: RuntimeClient,
  state: LocalObservationState,
  nudgeState: LocalPrNudgeState,
): Promise<boolean> {
  if (shouldSuppressPrNudgeForStaleCompletedBranch(state)) return false

  const onFeatureBranch = isTakeoverFeatureBranch(state.activeBranch)
  const hasDirtyFiles = state.modifiedFiles.length > 0
  const hasLocalCommitsToPush = state.branchAhead > 0
  const hasLocalBranchBehindRemote = state.branchBehind > 0
  const hasBranchReadyForPr = !state.prUrl && onFeatureBranch && state.baseAhead > 0
  const hasPrBehindBase = !!state.prUrl && state.baseSha !== undefined && state.baseBehind > 0
  const hasPrChecksNeedingAttention = !!state.prUrl && (state.prCheckState === 'failure' || state.prCheckState === 'unknown')
  const hasPrWithOpenTasks = !!state.prUrl && state.tasks.some(task => task.status !== 'done')
  if (
    !hasDirtyFiles &&
    !hasLocalCommitsToPush &&
    !hasLocalBranchBehindRemote &&
    !hasBranchReadyForPr &&
    !hasPrBehindBase &&
    !hasPrChecksNeedingAttention &&
    !hasPrWithOpenTasks
  ) return false

  const recipients = collectPrNudgeRecipients(state)
  if (recipients.length === 0) return false

  const signature = buildPrNudgeSignature(state)
  const now = Date.now()
  if (nudgeState.lastSignature === signature && now - (nudgeState.lastSentAt ?? 0) < 90_000) {
    return false
  }

  const summary = state.modifiedFiles.slice(0, 6).join(', ')
  const contextLines: string[] = []
  if (state.prUrl) {
    contextLines.push(`PR: ${state.prUrl}.`)
  }
  if (hasDirtyFiles) {
    contextLines.push(`Modified files: ${summary}${state.modifiedFiles.length > 6 ? ', ...' : ''}.`)
  }
  if (hasLocalCommitsToPush) {
    contextLines.push(`Current branch is ahead of origin by ${state.branchAhead} commit${state.branchAhead === 1 ? '' : 's'}.`)
  }
  if (hasLocalBranchBehindRemote) {
    contextLines.push(`Current branch is behind its upstream by ${state.branchBehind} commit${state.branchBehind === 1 ? '' : 's'}; fetch and sync before completion.`)
  }
  if (hasBranchReadyForPr && !hasDirtyFiles && !hasLocalCommitsToPush) {
    contextLines.push(
      state.hasUpstream
        ? `Feature branch ${state.activeBranch} is pushed to origin but still has no PR.`
        : `Feature branch ${state.activeBranch} has commits over origin/main but no upstream or PR yet.`,
    )
  }
  if (state.baseBehind > 0) {
    contextLines.push(`Feature branch is behind origin/main by ${state.baseBehind} commit${state.baseBehind === 1 ? '' : 's'}; sync it before PR creation or completion.`)
  }
  if (hasPrChecksNeedingAttention) {
    contextLines.push(`PR checks are ${state.prCheckState}; do not treat the takeover as complete yet.`)
  }
  if (hasPrWithOpenTasks) {
    const openTasks = state.tasks.filter(task => task.status !== 'done').length
    contextLines.push(`${openTasks} task${openTasks === 1 ? '' : 's'} still need wanman task done before completion.`)
  }

  const nextAction = state.prUrl
    ? 'Immediately fetch origin, rebase or merge origin/main, rerun the relevant verification commands locally, push the synchronized branch, wait for PR checks to pass or document that no checks are configured, then mark the remaining tasks done and notify cto.'
    : onFeatureBranch
    ? 'Immediately commit any remaining verified changes, fetch origin, rebase or merge origin/main, run the relevant verification commands locally, push the synchronized task branch to origin, create a PR only if verification passes, then notify cto with the PR URL.'
    : 'Immediately switch from detached HEAD to a task branch (`wanman/<task-slug>`), commit the verified changes, fetch origin, rebase or merge origin/main, run the relevant verification commands locally, push to origin, create a PR only if verification passes, then notify cto with the PR URL.'
  const payload = [
    state.prUrl
      ? 'Takeover has a PR, but it is not completion-ready yet.'
      : 'Takeover has implementation progress but no PR exists yet.',
    ...contextLines,
    nextAction,
    'Do not leave validated work without a branch, commit, push, and PR; do not open a PR from a stale or failing branch.',
  ].join(' ')

  for (const to of recipients) {
    await runtime.sendMessage({
      from: 'takeover-pr-allocator',
      to,
      type: 'message',
      payload,
      priority: 'steer',
    }).catch(() => undefined)
  }

  nudgeState.lastSignature = signature
  nudgeState.lastSentAt = now
  console.log(`  [local] PR nudge: sent branch/commit/PR steer to ${recipients.join(', ')}`)
  return true
}

export function materializeLocalTakeoverProject(
  profile: ProjectProfile,
  generated: GeneratedAgentConfig,
  opts?: { enableBrain?: boolean },
): string {
  const wanmanDir = path.join(profile.path, '.wanman')
  const worktreePath = path.join(wanmanDir, 'worktree')

  execSync('git worktree prune', {
    cwd: profile.path,
    stdio: 'pipe',
  })
  const currentHead = execSync('git rev-parse --verify HEAD', {
    cwd: profile.path,
    encoding: 'utf-8',
  }).trim()
  fs.rmSync(worktreePath, { recursive: true, force: true })
  execSync(`git worktree add --detach -f "${worktreePath}" ${currentHead}`, {
    cwd: profile.path,
    stdio: 'pipe',
  })
  console.log(`  [local] Created git worktree at ${worktreePath}`)

  const localRuntimePaths: TakeoverRuntimePaths = {
    projectRoot: worktreePath,
    sharedSkillPath: path.join(wanmanDir, 'skills', 'takeover-context', 'SKILL.md'),
    cliCommand: 'wanman',
    localMode: true,
  }

  writeTakeoverOverlayFiles(profile, generated, {
    baseDir: wanmanDir,
    agentsDir: path.join(wanmanDir, 'agents'),
    skillsDir: path.join(wanmanDir, 'skills', 'takeover-context'),
    configPath: path.join(wanmanDir, 'agents.json'),
    workspaceRoot: path.join(wanmanDir, 'agents'),
    gitRoot: worktreePath,
    dbPath: path.join(wanmanDir, 'wanman.db'),
    runtimePaths: localRuntimePaths,
    enableBrain: opts?.enableBrain,
  })

  return wanmanDir
}

export async function runLocal(
  profile: ProjectProfile,
  generated: GeneratedAgentConfig,
  wanmanDir: string,
  opts: RunOptions,
): Promise<void> {
  const configPath = path.join(wanmanDir, 'agents.json')
  const agentsDir = path.join(wanmanDir, 'agents')
  const worktreePath = path.join(wanmanDir, 'worktree')
  const liveDashboardPath = path.join(wanmanDir, 'live-dashboard.txt')
  const sharedSkillsDir = path.join(wanmanDir, 'skills')
  fs.writeFileSync(liveDashboardPath, 'takeover starting...\n')
  warnLocalEnvironment(profile, worktreePath)

  console.log('\n  Starting supervisor locally...')
  console.log(`  Config:     ${configPath}`)
  console.log(`  Workspace:  ${agentsDir}`)
  console.log(`  Git root:   ${worktreePath}`)
  console.log(`  Runtime:    ${generated.runtime}`)
  if (generated.runtime === 'codex') {
    const codexModel = opts.codexModel ?? process.env['WANMAN_CODEX_MODEL'] ?? process.env['WANMAN_MODEL'] ?? 'default'
    const codexEffort = opts.codexReasoningEffort ?? process.env['WANMAN_CODEX_REASONING_EFFORT'] ?? 'default'
    console.log(`  Codex:      ${codexModel} / ${codexEffort}`)
  }
  await runLocalSupervisorSession({
    supervisor: {
      configPath,
      workspaceRoot: agentsDir,
      gitRoot: worktreePath,
      sharedSkillsDir,
      homeRoot: wanmanDir,
      goal: generated.goal,
      runtime: generated.runtime,
      codexModel: opts.codexModel,
      codexReasoningEffort: opts.codexReasoningEffort,
    },
    keep: opts.keep,
    signalMode: 'forward_only',
    onStarted: ({ entrypoint, port }) => {
      console.log(`  Entrypoint: ${entrypoint}`)
      console.log(`  Port:       ${port}`)
    },
    onHealthy: ({ port }) => {
      console.log(`  Supervisor healthy on http://127.0.0.1:${port}`)
    },
    onStopped: () => {
      if (process.stdout.isTTY) logUpdate.clear()
    },
    onKeptAlive: () => {
      if (process.stdout.isTTY) logUpdate.clear()
    },
    run: async ({ supervisor, runtime, child, port }) => {
      const coordinationBackend = createLoggedLocalCoordinationBackend(runtime)
      await ensureMissionBoard(coordinationBackend, profile, generated.intent)
      await sendKickoffSteer(coordinationBackend, generated.intent, 'local-takeover-bootstrap')

      const startedAt = Date.now()
      let observedLoops = 0
      let idlePolls = 0
      let logCursor = 0
      const localLogs: string[] = []
      const initialLogs = await supervisor.readLogs(logCursor)
      logCursor = initialLogs.cursor
      appendLogLines(localLogs, initialLogs.lines)
      let previous = await collectLocalObservationState(runtime, worktreePath, localLogs)
      let lastProgressAt = Date.now()
      const prNudgeState: LocalPrNudgeState = {}
      const missionNudgeState: LocalMissionNudgeState = {}
      const fallbackBacklogState: LocalFallbackBacklogState = {}
      const executionWatchdogState = createLocalExecutionWatchdogState()
      const runtimeErrorGate = createRuntimeErrorGateState()
      let lastPrintedSnapshot = ''
      let childExitCode: number | null = null
      let childError: Error | null = null
      child.on('error', err => { childError = err })
      child.on('close', code => { childExitCode = code ?? 0 })
      const maxIdleMs = opts.infinite
        ? 10 * 60 * 1000
        : Math.max(opts.loops * opts.pollInterval * 30 * 1000, 180_000)

      while (opts.infinite || observedLoops < opts.loops) {
        await new Promise(resolve => setTimeout(resolve, opts.pollInterval * 1000))
        const nextLogs = await supervisor.readLogs(logCursor)
        logCursor = nextLogs.cursor
        appendLogLines(localLogs, nextLogs.lines)
        let current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const runtimeErrors = evaluateRuntimeErrorGate(
          runtimeErrorGate,
          nextLogs.lines,
          opts.errorLimit ?? MAX_RUNTIME_ERROR_RETRIES,
        )
        for (const retry of runtimeErrors.retries) {
          await runtime.sendMessage({
            from: 'takeover-runtime-error-gate',
            to: retry.agent,
            type: 'message',
            priority: 'steer',
            payload: `Runtime error observed for ${retry.agent} (${retry.count}/${opts.errorLimit ?? MAX_RUNTIME_ERROR_RETRIES}). Retry once from a clean task state. Last error: ${retry.detail}`,
          }).catch(() => undefined)
          console.log(`  [local] Runtime error retry ${retry.count}/${opts.errorLimit ?? MAX_RUNTIME_ERROR_RETRIES}: ${retry.agent}`)
        }
        if (runtimeErrors.failed && runtimeErrors.failure) {
          const taskSummary = current.tasks
            .map(task => `${task.id.slice(0, 8)}:${task.status}${task.assignee ? `->${task.assignee}` : ''}`)
            .join(', ') || 'no tasks'
          throw new Error([
            `Local takeover stopped after repeated runtime_error from ${runtimeErrors.failure.agent}.`,
            `count=${runtimeErrors.failure.count}`,
            `last=${runtimeErrors.failure.detail}`,
            `tasks=${taskSummary}`,
          ].join(' '))
        }
        const completionReason = getLocalCompletionReason(current)
        if (completionReason) {
          if (process.stdout.isTTY) logUpdate.clear()
          console.log(`\n  [local] Takeover complete: ${completionReason}`)
          previous = current
          break
        }
        const nudgedMission = await maybeNudgeLocalMissionControl(runtime, current, generated.intent, missionNudgeState).catch(() => false)
        if (nudgedMission) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const repairedCapsules = await repairLocalCapsuleGaps(runtime, current, generated.intent, worktreePath, {
          log: message => console.log(`  [local] ${message}`),
        }).catch(() => false)
        if (repairedCapsules) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const seededFallbackBacklog = await seedLocalFallbackBacklog(runtime, current, generated.intent, worktreePath, {
          seedState: fallbackBacklogState,
          log: message => console.log(`  [local] ${message}`),
        }).catch(() => false)
        if (seededFallbackBacklog) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const recoveredOrphans = await recoverOrphanLocalTasks(runtime, current, {
          log: message => console.log(`  [local] ${message}`),
        }).catch(() => false)
        if (recoveredOrphans) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const scaled = await maybeScaleLocalWorkforce(runtime, current).catch(() => false)
        if (scaled) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        const nudgedPr = await maybeNudgeLocalPrExecution(runtime, current, prNudgeState).catch(() => false)
        if (nudgedPr) current = await collectLocalObservationState(runtime, worktreePath, localLogs)
        await maybeNudgeStalledLocalExecution(runtime, previous, current, nextLogs.lines, executionWatchdogState, {
          log: message => console.log(`  [local] ${message}`),
        }).catch(() => false)
        const progressed = hasLocalProgress(previous, current)
        const dashboardMaxLoops = opts.infinite ? Math.max(observedLoops, 1) : opts.loops
        const dashboardState = buildLocalDashboardState(
          `takeover: ${path.basename(profile.path)}`,
          observedLoops,
          dashboardMaxLoops,
          startedAt,
          current,
        )
        const dashboardSnapshot = formatDashboard(dashboardState)
        fs.writeFileSync(liveDashboardPath, `${dashboardSnapshot}\n`)
        if (process.stdout.isTTY) {
          renderDashboard(dashboardState)
        }

        if (progressed) {
          observedLoops++
          idlePolls = 0
          lastProgressAt = Date.now()
          const done = current.tasks.filter(task => task.status === 'done').length
          const runId = current.health.loop?.runId ?? 'unknown'
          const completedRuns = current.health.runtime?.completedRuns ?? 0
          if (!process.stdout.isTTY) {
            const loopLabel = opts.infinite ? observedLoops : `${observedLoops}/${opts.loops}`
            console.log(`  [local] Loop ${loopLabel}: ${current.tasks.length} task(s), ${done} done, ${completedRuns} completed run(s), runId=${runId}`)
            if (dashboardSnapshot !== lastPrintedSnapshot) {
              console.log(dashboardSnapshot)
              lastPrintedSnapshot = dashboardSnapshot
            }
          }
        } else {
          idlePolls++
          if (!process.stdout.isTTY && idlePolls % Math.max(1, Math.ceil(15 / opts.pollInterval)) === 0) {
            const completedRuns = current.health.runtime?.completedRuns ?? 0
            console.log(`  [local] Waiting for progress: ${current.tasks.length} task(s), ${completedRuns} completed run(s)`)
            if (dashboardSnapshot !== lastPrintedSnapshot) {
              console.log(dashboardSnapshot)
              lastPrintedSnapshot = dashboardSnapshot
            }
          }
          if (Date.now() - lastProgressAt >= maxIdleMs) {
            throw new Error(`Local takeover made no observable progress for ${Math.round(maxIdleMs / 1000)}s on port ${port}`)
          }
        }
        if (childError) throw childError
        if (childExitCode !== null && childExitCode !== 0) {
          throw new Error(`Supervisor exited with code ${childExitCode}`)
        }
        if (childExitCode === 0 && opts.infinite) {
          if (process.stdout.isTTY) logUpdate.clear()
          console.log('\n  [local] Supervisor exited cleanly before a PR was created')
          break
        }
        previous = current
      }
    },
  })
}
