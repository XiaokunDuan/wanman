import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalObservationState } from './takeover-local.js'
import {
  appendLogLines,
  buildLocalDashboardState,
  buildPrNudgeSignature,
  collectPrNudgeRecipients,
  createRuntimeErrorGateState,
  evaluateRuntimeErrorGate,
  getLocalCompletionReason,
  hasLocalProgress,
  materializeLocalTakeoverProject,
  maybeNudgeLocalPrExecution,
  parseLocalGitStatus,
  planLocalDynamicClone,
  recoverOrphanLocalTasks,
} from './takeover-local.js'
import type { GeneratedAgentConfig, ProjectProfile } from './takeover-project.js'

function makeState(overrides: Partial<LocalObservationState> = {}): LocalObservationState {
  return {
    health: {
      agents: [
        { name: 'ceo', state: 'idle', lifecycle: '24/7' },
        { name: 'dev', state: 'idle', lifecycle: 'on-demand' },
        { name: 'dev-1', state: 'idle', lifecycle: 'on-demand' },
      ],
    },
    tasks: [],
    initiatives: [],
    capsules: [],
    artifacts: [],
    logs: [],
    activeBranch: undefined,
    branchAhead: 0,
    branchBehind: 0,
    baseAhead: 0,
    baseBehind: 0,
    hasUpstream: false,
    prUrl: undefined,
    prState: undefined,
    prCheckState: 'none',
    headSha: 'head',
    baseSha: 'base',
    headCiState: 'none',
    baseCiState: 'none',
    modifiedFiles: [],
    ...overrides,
  }
}

describe('parseLocalGitStatus', () => {
  it('extracts branch state and changed paths from porcelain v2 output', () => {
    const state = parseLocalGitStatus([
      '# branch.head wanman/task',
      '# branch.upstream origin/wanman/task',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc abc src/app.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 src/new.ts\tsrc/old.ts',
      'u UU N... 100644 100644 100644 100644 abc abc abc conflicted.ts',
      '? notes.md',
      '! ignored.log',
    ].join('\n'))

    expect(state).toEqual({
      activeBranch: 'wanman/task',
      branchAhead: 2,
      branchBehind: 1,
      baseAhead: 0,
      baseBehind: 0,
      hasUpstream: true,
      headSha: undefined,
      baseSha: undefined,
      modifiedFiles: ['src/app.ts', 'src/new.ts', 'conflicted.ts', 'notes.md', 'ignored.log'],
    })
  })

  it('treats detached heads as no active branch', () => {
    expect(parseLocalGitStatus('# branch.head (detached)\n').activeBranch).toBeUndefined()
  })
})

describe('local takeover progress helpers', () => {
  it('detects progress across task, board, artifact, and worktree snapshots', () => {
    const previous = makeState({
      tasks: [{ id: '1', title: 'Task', status: 'todo', assignee: 'dev', priority: 1 }],
    })

    expect(hasLocalProgress(previous, makeState({
      tasks: [{ id: '1', title: 'Task', status: 'done', assignee: 'dev', priority: 1 }],
    }))).toBe(true)
    expect(hasLocalProgress(previous, makeState({
      tasks: previous.tasks,
      initiatives: [{ id: 'i1', title: 'Initiative', status: 'active' }],
    }))).toBe(true)
    expect(hasLocalProgress(previous, makeState({
      tasks: previous.tasks,
      artifacts: [{ agent: 'dev', kind: 'patch', cnt: 1 }],
    }))).toBe(true)
    expect(hasLocalProgress(previous, makeState({
      tasks: previous.tasks,
      modifiedFiles: ['src/app.ts'],
    }))).toBe(true)
    expect(hasLocalProgress(previous, makeState({ tasks: previous.tasks }))).toBe(false)
  })

  it('plans dynamic dev clones only when backlog needs more workers', () => {
    const plan = planLocalDynamicClone(makeState({
      health: {
        agents: [{ name: 'ceo', state: 'idle', lifecycle: '24/7' }],
      },
      tasks: [
        { id: '1', title: 'A', status: 'todo', assignee: 'dev', priority: 1 },
        { id: '2', title: 'B', status: 'todo', assignee: 'dev', priority: 1 },
        { id: '3', title: 'C', status: 'todo', assignee: 'dev', priority: 1 },
      ],
    }))

    expect(plan?.clonesToSpawn).toEqual(['dev-2', 'dev-3'])
    expect(plan?.reassignments).toEqual([
      { taskId: '2', taskTitle: 'B', assignee: 'dev-2' },
      { taskId: '3', taskTitle: 'C', assignee: 'dev-3' },
    ])
  })

  it('keeps a bounded trimmed local log buffer', () => {
    const lines: string[] = ['old']

    appendLogLines(lines, [' first ', '', 'second', 'third'], 3)

    expect(lines).toEqual(['first', 'second', 'third'])
  })

  it('recovers implementation tasks that are pending without an assignee', async () => {
    const updateTask = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const log = vi.fn()

    await expect(recoverOrphanLocalTasks(
      { updateTask, sendMessage },
      makeState({
        tasks: [
          { id: '12345678-orphan', title: 'Implement playable match-3 game', status: 'pending', priority: 1 },
          { id: '87654321-docs', title: 'Write notes', status: 'pending', priority: 5 },
          { id: 'assigned', title: 'Fix UI', status: 'assigned', assignee: 'dev', priority: 2 },
        ],
      }),
      { log },
    )).resolves.toBe(true)

    expect(updateTask).toHaveBeenCalledWith({
      id: '12345678-orphan',
      status: 'assigned',
      assignee: 'dev',
      agent: 'takeover-orphan-recovery',
    })
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      from: 'takeover-orphan-recovery',
      to: 'dev',
      priority: 'steer',
    }))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('orphan_task_recovered'))
    expect(updateTask).toHaveBeenCalledTimes(1)
  })

  it('does not recover orphan tasks when the target worker is unavailable', async () => {
    const updateTask = vi.fn().mockResolvedValue(undefined)
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    await expect(recoverOrphanLocalTasks(
      { updateTask, sendMessage },
      makeState({
        health: { agents: [{ name: 'ceo', state: 'idle', lifecycle: '24/7' }] },
        tasks: [{ id: '12345678-orphan', title: 'Implement feature', status: 'pending', priority: 1 }],
      }),
    )).resolves.toBe(false)

    expect(updateTask).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('gates repeated runtime errors with bounded retries and fail-fast', () => {
    const gate = createRuntimeErrorGateState()

    expect(evaluateRuntimeErrorGate(gate, ['13:23 agent-process runtime_error (ceo)'])).toEqual({
      failed: false,
      retries: [{ agent: 'ceo', count: 1, detail: '13:23 agent-process runtime_error (ceo)' }],
    })
    expect(evaluateRuntimeErrorGate(gate, ['13:23 agent-process runtime_error (ceo)'])).toEqual({
      failed: false,
      retries: [],
    })
    expect(evaluateRuntimeErrorGate(gate, ['13:24 agent-process runtime_error (ceo)'])).toMatchObject({
      failed: false,
      retries: [{ agent: 'ceo', count: 2 }],
    })
    expect(evaluateRuntimeErrorGate(gate, ['13:25 agent-process runtime_error (ceo)'])).toMatchObject({
      failed: true,
      failure: { agent: 'ceo', count: 3 },
    })
  })

  it('extracts runtime error agents from structured supervisor logs', () => {
    const gate = createRuntimeErrorGateState()
    const line = JSON.stringify({
      ts: '2026-06-29T11:00:00.000Z',
      level: 'warn',
      scope: 'agent-process',
      msg: 'runtime_error',
      agent: 'dev',
      detail: 'turn failed',
    })

    expect(evaluateRuntimeErrorGate(gate, [line])).toMatchObject({
      failed: false,
      retries: [{ agent: 'dev', count: 1 }],
    })
  })

  it('builds dashboard state from local observation state', () => {
    const state = buildLocalDashboardState('takeover: app', 0, 0, Date.now(), makeState({
      activeBranch: 'wanman/task',
      prUrl: 'https://github.com/acme/app/pull/1',
      tasks: [{ id: '1', title: 'Task', status: 'done', assignee: 'dev', priority: 1 }],
      logs: ['ready'],
      artifacts: [{ agent: 'dev', kind: 'patch', cnt: 1 }],
    }))

    expect(state.loop).toBe(1)
    expect(state.maxLoops).toBe(1)
    expect(state.brainName).toBe('PR: https://github.com/acme/app/pull/1')
    expect(state.agents.map(agent => agent.name)).toEqual(['ceo', 'dev', 'dev-1'])
    expect(state.tasks).toHaveLength(1)
    expect(state.artifacts).toHaveLength(1)
  })

  it('recognizes clean completion on green main, green PR, or absorbed branches', () => {
    const doneTask = { id: '1', title: 'Done', status: 'done', assignee: 'dev', priority: 1 }

    expect(getLocalCompletionReason(makeState({
      activeBranch: 'main',
      tasks: [doneTask],
      headCiState: 'success',
      baseCiState: 'success',
    }))).toContain('green CI')

    expect(getLocalCompletionReason(makeState({
      activeBranch: 'wanman/task',
      tasks: [doneTask],
      prUrl: 'https://github.com/acme/app/pull/1',
      prCheckState: 'success',
      baseCiState: 'pending',
    }))).toContain('PR branch is current')

    expect(getLocalCompletionReason(makeState({
      activeBranch: 'wanman/task',
      tasks: [doneTask],
      baseAhead: 0,
      baseBehind: 2,
      baseCiState: 'success',
    }))).toContain('origin/main')
  })

  it('does not complete when work is dirty, unpushed, unfinished, or failing checks', () => {
    const doneTask = { id: '1', title: 'Done', status: 'done', assignee: 'dev', priority: 1 }

    expect(getLocalCompletionReason(makeState({
      activeBranch: 'main',
      tasks: [{ ...doneTask, status: 'in_progress' }],
      headCiState: 'success',
      baseCiState: 'success',
    }))).toBeUndefined()
    expect(getLocalCompletionReason(makeState({
      activeBranch: 'main',
      tasks: [doneTask],
      modifiedFiles: ['src/app.ts'],
      headCiState: 'success',
      baseCiState: 'success',
    }))).toBeUndefined()
    expect(getLocalCompletionReason(makeState({
      activeBranch: 'main',
      tasks: [doneTask],
      branchAhead: 1,
      headCiState: 'success',
      baseCiState: 'success',
    }))).toBeUndefined()
    expect(getLocalCompletionReason(makeState({
      activeBranch: 'main',
      tasks: [doneTask],
      branchBehind: 1,
      headCiState: 'success',
      baseCiState: 'success',
    }))).toBeUndefined()
    expect(getLocalCompletionReason(makeState({
      activeBranch: 'main',
      tasks: [doneTask],
      headCiState: 'failure',
      baseCiState: 'failure',
    }))).toBeUndefined()
    expect(getLocalCompletionReason(makeState({
      activeBranch: 'wanman/task',
      tasks: [doneTask],
      prUrl: 'https://github.com/acme/app/pull/1',
      prCheckState: 'failure',
    }))).toBeUndefined()
    expect(getLocalCompletionReason(makeState({
      activeBranch: 'wanman/task',
      tasks: [doneTask],
      prUrl: 'https://github.com/acme/app/pull/1',
      prCheckState: 'success',
      baseBehind: 1,
    }))).toBeUndefined()
    expect(getLocalCompletionReason(makeState({
      activeBranch: 'wanman/task',
      tasks: [doneTask],
      hasUpstream: true,
      baseAhead: 1,
      baseCiState: 'success',
    }))).toBeUndefined()
  })
})

describe('maybeNudgeLocalPrExecution', () => {
  it('steers implementers and mission control when progress has no PR', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const state = makeState({
      activeBranch: 'wanman/task',
      branchAhead: 2,
      hasUpstream: true,
      modifiedFiles: ['src/app.ts', 'src/test.ts'],
      tasks: [
        { id: '1', title: 'Implement', status: 'todo', assignee: 'dev', priority: 1 },
        { id: '2', title: 'Review', status: 'in_progress', assignee: 'dev-1', priority: 1 },
        { id: '3', title: 'Done', status: 'done', assignee: 'devops', priority: 1 },
      ],
    })
    const nudgeState: { lastSignature?: string; lastSentAt?: number } = {}

    await expect(maybeNudgeLocalPrExecution({ sendMessage } as never, state, nudgeState)).resolves.toBe(true)

    expect(collectPrNudgeRecipients(state)).toEqual(['dev', 'dev-1', 'ceo'])
    expect(buildPrNudgeSignature(state)).toContain('wanman/task')
    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      from: 'takeover-pr-allocator',
      to: 'dev',
      priority: 'steer',
    }))
    expect(sendMessage.mock.calls[0]?.[0]?.payload).toContain('rebase or merge origin/main')
    expect(sendMessage.mock.calls[0]?.[0]?.payload).toContain('create a PR only if verification passes')
    expect(nudgeState.lastSignature).toBeDefined()

    await expect(maybeNudgeLocalPrExecution({ sendMessage } as never, state, nudgeState)).resolves.toBe(false)
    expect(sendMessage).toHaveBeenCalledTimes(3)
  })

  it('does not send PR nudges when an existing PR is not actionable or no branch work is ready', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({
        prUrl: 'https://github.com/acme/app/pull/1',
        prCheckState: 'pending',
        tasks: [{ id: '1', title: 'Done', status: 'done', assignee: 'dev', priority: 1 }],
      }),
      {},
    )).resolves.toBe(false)
    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({ activeBranch: 'main', tasks: [{ id: '1', title: 'Task', status: 'todo', assignee: 'dev', priority: 1 }] }),
      {},
    )).resolves.toBe(false)

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('nudges existing PRs when they are behind main, failing checks, or still have open tasks', async () => {
    const behindSendMessage = vi.fn().mockResolvedValue(undefined)
    const failingSendMessage = vi.fn().mockResolvedValue(undefined)
    const openTaskSendMessage = vi.fn().mockResolvedValue(undefined)
    const doneTask = { id: '1', title: 'Done', status: 'done', assignee: 'dev', priority: 1 }

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage: behindSendMessage } as never,
      makeState({
        activeBranch: 'wanman/task',
        prUrl: 'https://github.com/acme/app/pull/1',
        prCheckState: 'success',
        baseBehind: 2,
        tasks: [doneTask],
      }),
      {},
    )).resolves.toBe(true)
    expect(behindSendMessage.mock.calls[0]?.[0]?.payload).toContain('not completion-ready')
    expect(behindSendMessage.mock.calls[0]?.[0]?.payload).toContain('rebase or merge origin/main')

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage: failingSendMessage } as never,
      makeState({
        activeBranch: 'wanman/task',
        prUrl: 'https://github.com/acme/app/pull/1',
        prCheckState: 'failure',
        tasks: [doneTask],
      }),
      {},
    )).resolves.toBe(true)
    expect(failingSendMessage.mock.calls[0]?.[0]?.payload).toContain('PR checks are failure')

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage: openTaskSendMessage } as never,
      makeState({
        activeBranch: 'wanman/task',
        prUrl: 'https://github.com/acme/app/pull/1',
        prCheckState: 'success',
        tasks: [{ id: '2', title: 'Implement', status: 'in_progress', assignee: 'dev', priority: 1 }],
      }),
      {},
    )).resolves.toBe(true)
    expect(openTaskSendMessage.mock.calls[0]?.[0]?.payload).toContain('still need wanman task done')
  })

  it('does not nudge stale completed branches that are behind main or already closed', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const doneTask = { id: '1', title: 'Done', status: 'done', assignee: 'dev', priority: 1 }

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({
        activeBranch: 'wanman/task',
        hasUpstream: true,
        tasks: [doneTask],
        baseAhead: 0,
        baseBehind: 2,
        baseCiState: 'success',
      }),
      {},
    )).resolves.toBe(false)

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({
        activeBranch: 'wanman/task',
        hasUpstream: true,
        tasks: [doneTask],
        baseBehind: 1,
        prState: 'CLOSED',
      }),
      {},
    )).resolves.toBe(false)

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('nudges completed pushed branches that still have unmerged work over main', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const doneTask = { id: '1', title: 'Done', status: 'done', assignee: 'dev', priority: 1 }

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({
        activeBranch: 'wanman/task',
        hasUpstream: true,
        tasks: [doneTask],
        baseAhead: 1,
        baseCiState: 'success',
      }),
      {},
    )).resolves.toBe(true)

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      from: 'takeover-pr-allocator',
      to: 'ceo',
    }))
  })

  it('nudges feature branches with local commits over main even before upstream is configured', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({
        activeBranch: 'wanman/task',
        hasUpstream: false,
        tasks: [{ id: '1', title: 'Done', status: 'done', assignee: 'dev', priority: 1 }],
        baseAhead: 1,
      }),
      {},
    )).resolves.toBe(true)

    expect(sendMessage.mock.calls[0]?.[0]?.payload).toContain('no upstream or PR yet')
  })

  it('does not nudge pushed branches with no diff over main', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    await expect(maybeNudgeLocalPrExecution(
      { sendMessage } as never,
      makeState({
        activeBranch: 'wanman/task',
        hasUpstream: true,
        tasks: [{ id: '1', title: 'Implement', status: 'in_progress', assignee: 'dev', priority: 1 }],
        baseAhead: 0,
        baseBehind: 0,
      }),
      {},
    )).resolves.toBe(false)

    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('materializeLocalTakeoverProject', () => {
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'wanman-takeover-project-'))
    tmpDirs.push(dir)
    return dir
  }

  it('creates a local worktree and writes local-mode takeover overlay files', () => {
    const repo = makeTmpDir()
    execGit(repo, 'init')
    execGit(repo, 'config user.email test@example.com')
    execGit(repo, 'config user.name Test')
    fs.writeFileSync(path.join(repo, 'README.md'), '# App\n')
    execGit(repo, 'add README.md')
    execGit(repo, 'commit -m init')

    const profile: ProjectProfile = {
      path: repo,
      languages: ['typescript'],
      packageManagers: [],
      frameworks: [],
      ci: [],
      testFrameworks: [],
      hasReadme: true,
      hasClaudeMd: false,
      hasDocs: false,
      issueTracker: 'none',
      readmeExcerpt: 'App',
      codeRoots: ['src'],
      packageScripts: ['test'],
    }
    const generated: GeneratedAgentConfig = {
      runtime: 'codex',
      goal: 'Ship project',
      intent: {
        projectName: 'app',
        summary: 'Ship project',
        canonicalDocs: [],
        roadmapDocs: [],
        codeRoots: ['src'],
        packageScripts: ['test'],
        strategicThemes: ['quality'],
        mission: 'Ship project',
      },
      agents: [
        {
          name: 'ceo',
          lifecycle: '24/7',
          runtime: 'codex',
          model: 'high',
          systemPromptHint: 'Lead',
          enabled: true,
          reason: 'test',
        },
      ],
    }

    const wanmanDir = materializeLocalTakeoverProject(profile, generated)

    expect(wanmanDir).toBe(path.join(repo, '.wanman'))
    expect(fs.existsSync(path.join(wanmanDir, 'worktree', 'README.md'))).toBe(true)
    expect(fs.readFileSync(path.join(wanmanDir, 'agents', 'ceo', 'AGENT.md'), 'utf-8')).toContain('CEO Takeover Agent')
    const agentsConfig = JSON.parse(fs.readFileSync(path.join(wanmanDir, 'agents.json'), 'utf-8')) as {
      gitRoot: string
      agents: Array<{ model: string }>
    }
    expect(agentsConfig.gitRoot).toBe(path.join(wanmanDir, 'worktree'))
    expect(agentsConfig.agents[0]?.model).toBe('high')
    expect(fs.readFileSync(path.join(wanmanDir, 'skills', 'takeover-context', 'SKILL.md'), 'utf-8')).toContain('Ship project')
  })
})

function execGit(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'ignore' })
}
