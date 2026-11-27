import { AgentAPI, credential, defaults, endpoint, models, portal, runtimes } from './lib/agentapi.js'
import { hostModule, installCloud, view } from './lib/provider.js'
import { repositoryCredentials, selectedAttachments } from './lib/inputs.js'
import { pausedForParent } from './lib/turn-control.js'
import { terminal, statusText } from './lib/run.js'
import { readUsage } from './lib/usage.js'
import { delegateParameters, statusParameters, cancelParameters, pageParameters } from './lib/tool-parameters.js'

export const name = 'xgrowthlab-agentapi'
export const inject = ['credentials', 'subagents', 'tools', 'storage', 'connection', 'attachments', 'systemPrompt', 'llm', 'agents']
const textOutput = { schema: { type: 'object' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }

export async function apply(ctx) {
  const kv = ctx.storage.backend.get('json').kv
  const unit = await kv.open({ name: 'xgrowthlab_agentapi', version: 1, tables: [], hasGlobal: true, layout: 'single' })
  const state = (await unit.loadAll()).global || {}
  state.settings ??= { ...defaults }
  if (!state.nativeDefaultApplied) {
    if (!state.settings.agentId && state.settings.runtime === 'claudecode' && state.settings.model === models.claudecode[0]) {
      Object.assign(state.settings, { runtime: defaults.runtime, model: defaults.model })
    }
    state.nativeDefaultApplied = true
  }
  state.tasks ??= {}
  state.resources ??= {}
  let writes = Promise.resolve()
  function persist() {
    const next = structuredClone(state)
    writes = writes.catch(() => {}).then(() => unit.setGlobal(next))
    return writes
  }
  ctx.effect(() => async () => { await writes; await unit.close() })
  for (const task of Object.values(state.tasks)) {
    if (!terminal.has(task.status)) {
      task.status = task.sessionId ? 'unconfirmed' : 'failed'
      task.reason = task.sessionId ? 'Harness 已重新启动，可在 Portal 核对这次执行。' : 'Harness 在准备任务时关闭。'
    }
  }
  await persist()

  const readKey = async () => (await ctx.credentials.readRecord(credential))?.key
  async function snapshot() {
    const key = await readKey()
    if (!key) throw new Error('请在 Harness 设置 → 云端智能体 中配置 AgentAPI Key。')
    return { api: new AgentAPI(key), config: { ...state.settings } }
  }
  const dispatch = installCloud(ctx, { tasks: state.tasks, resources: state.resources, snapshot, persist })

  function owned(owner, id) {
    const task = Object.hasOwn(state.tasks, id) && state.tasks[id]
    if (!task || task.owner !== owner) throw new Error('当前会话中找不到该任务')
    return task
  }
  const list = owner => Object.values(state.tasks).filter(task => task.owner === owner).reverse().map(view)

  const { validateJsonSchemaValue } = hostModule('@deepseek-ai/dsh-tools')
  function register(name, description, parameters, execute) {
    ctx.tools.register({ name, description, parameters, output: textOutput, async execute(args, exec) {
      const errors = validateJsonSchemaValue(parameters, args, '')
      if (errors.length) throw new Error(errors.join(' / '))
      return execute(args, exec)
    } })
  }

  register('agentapi_delegate',
    'Delegate work asynchronously to a new cloud agent Session. Include the goal, relevant context and expected deliverable in task. On acceptance, acknowledge the handoff to the user. The child reports its result to this conversation. Use send_message with its returned name for follow-ups.',
    delegateParameters, async ({ task, title, commit, attachments: names, ...sessionOptions }, exec) => {
      if (!task.trim()) throw new Error('task must contain the first message for the cloud agent.')
      const { agent, environment_id, metadata } = sessionOptions
      if (agent !== undefined && !(typeof agent === 'string' ? agent : agent.id).trim()) throw new Error('agent requires an AgentAPI agent ID.')
      if (agent?.version !== undefined && agent.version < 1) throw new Error('agent.version must be positive.')
      if (environment_id !== undefined && !environment_id.trim()) throw new Error('environment_id must contain an AgentAPI environment ID.')
      if (agent && typeof agent === 'object' && agent.type !== 'agent_with_overrides' &&
        (agent.model != null || ['system', 'tools', 'mcp_servers', 'skills'].some(key => Object.hasOwn(agent, key)))) {
        throw new Error('Set agent.type to agent_with_overrides to replace Agent settings.')
      }
      if (metadata && (Object.keys(metadata).length > 16 || Object.entries(metadata).some(([k, v]) =>
        typeof v !== 'string' || [...k].length > 64 || [...v].length > 512))) {
        throw new Error('metadata accepts up to 16 string pairs with keys up to 64 characters and values up to 512.')
      }
      const attachments = selectedAttachments(exec.agent.session.deriveMessages(), names)
      if (sessionOptions.resources) sessionOptions.resources = await repositoryCredentials(sessionOptions.resources, ctx.credentials)
      return dispatch(exec.agent, { text: task, title, commit, attachments, sessionOptions }, exec.signal)
    })

  for (const [kind, description] of [
    ['agents', 'List reusable AgentAPI agent definitions with id, version, runtime and model. Use an id in agentapi_delegate.agent. For existing DSH children, use list_agents.'],
    ['environments', 'List AgentAPI execution environments with id, type, status and network mode. Use an id in agentapi_delegate.environment_id.'],
  ]) {
    register('agentapi_list_' + kind, description, pageParameters, async (args, exec) => {
      const { api } = await snapshot()
      return api.catalogPage(kind, args, exec.signal)
    })
  }

  register('agentapi_status',
    'Read a cloud child’s last known state, summary, output files and Portal link by DSH child id. Omit id to list your cloud children.',
    statusParameters, async ({ id }, exec) => {
      if (id !== undefined) return view(owned(exec.agent.id, id))
      return { tasks: list(exec.agent.id) }
    })
  register('agentapi_cancel',
    'Stop the current turn of a cloud child by DSH child id when the user requests it. The Session stays available for follow-up.',
    cancelParameters, async ({ id }, exec) => {
      const task = owned(exec.agent.id, id)
      if (task.nativeChild && (!terminal.has(task.status) || task.status === 'unconfirmed')) {
        return dispatch.stop(task, exec.agent)
      }
      return view(task)
    })

  ctx.systemPrompt.section({ name: 'agentapi-cloud', order: 620, text: [
    'When the user starts a request with /cloud or asks for cloud execution, act as the dispatcher. Resolve references from the conversation, capture the user’s constraints and success criteria, and assign the execution to the cloud child. Leave investigation, implementation and verification to that child. Ask a focused question if essential input is missing.',
    'Use agentapi_delegate for new work. Omit agent and environment_id to use configured defaults. Use the catalog tools when the user asks what is available or a named resource needs an ID.',
    'For a follow-up, use send_message with the existing cloud child’s name. Use list_agents to recover its name. The child retains its Session context and files.',
    'After a successful handoff or follow-up, tell the user what you handed off and that the child will report back here. Continue any independent work the user requested. Leave the delegated work with the child and rely on its completion notice for the result. If delivery fails, tell the user what happened.',
    'When the user stops a child, acknowledge that assignment’s cancellation in the user’s language. Resume or replace that assignment only if the user asks. Continue independent work normally.',
    'Name selected attachments in the assignment. Ask the child to write downloadable deliverables under /mnt/session/outputs/. Report completion from the child’s result and check it against the user’s criteria.',
  ].join('\n') })

  ctx.systemPrompt.context({ name: 'agentapi-stopped-assignments', order: 621, interpolate: false, text: ({ agent }) => {
    if (!agent) return ''
    const stopped = Object.values(state.tasks).filter(task => task.owner === agent.id && task.userStopped && pausedForParent(task, agent))
    if (!stopped.length) return ''
    const names = stopped.map(task => ({ child: 'cloud-' + task.id.slice(0, 8), title: task.sessionTitle }))
    return 'The user stopped the following cloud assignments. Acknowledge the stop. Leave these assignments stopped, including replacement runs, until the user requests a follow-up. Other work may proceed. ' + JSON.stringify(names)
  } })

  async function settings() {
    return { configured: !!(await readKey()), settings: state.settings, models, runtimes, portal, endpoint }
  }
  // Read confirmed totals for visible children, including conversations from older plugin versions.
  const usageReads = new Map()
  async function catalog(ids, signal) {
    if (!Array.isArray(ids) || ids.length > 100) throw new Error('子会话列表无效')
    const tasks = [...new Set(ids)].filter(id => typeof id === 'string' && Object.hasOwn(state.tasks, id))
      .map(id => state.tasks[id]).filter(task => task.nativeChild)
    const now = Date.now()
    const due = tasks.filter(task => task.sessionId && (!terminal.has(task.status) || !task.usage)
      && now - (usageReads.get(task.id) ?? 0) > (terminal.has(task.status) ? 30000 : 5000))
    if (due.length) {
      // Bound simultaneous reads and the time spent waiting for a page of historical children.
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(3500)])
      const config = snapshot()
      let changed = false
      const queue = due.values()
      await Promise.all(Array.from({ length: Math.min(4, due.length) }, async () => {
        for (const task of queue) {
          if (timeout.aborted) break
          usageReads.set(task.id, now)
          try {
            const { api } = await config
            const usage = await readUsage(api, task, timeout)
            if (usage && terminal.has(task.status)) changed = true
          } catch { /* Retain the last confirmed sample while offline. */ }
        }
      }))
      if (changed) await persist()
    }
    return tasks.map(({ id, title, status, usage, reason }) => ({ id, title, status, label: statusText[status], reason: reason || null, usage: usage ?? null }))
  }
  async function rpc(method, body, signal) {
    if (method === 'catalog') return catalog(body.ids, signal)
    if (method === 'settings') return settings()
    if (method === 'save') {
      const value = body.key?.trim() || await readKey()
      if (!value || !/^[!-~]{1,4096}$/.test(value)) throw new Error('请输入有效的 AgentAPI Key')
      const api = new AgentAPI(value)
      await api.request('agents?limit=1', { signal })
      const { runtime, model, agentId = '', environmentId = '' } = body.settings || {}
      if (!Object.hasOwn(models, runtime) || !models[runtime].includes(model)) throw new Error('请选择兼容的运行时和模型')
      if (agentId) await api.resource('agents', agentId, signal)
      if (environmentId) await api.resource('environments', environmentId, signal)
      if (body.key?.trim()) await ctx.credentials.modifyRecord(credential, async () => ({ kind: 'api-key', key: value }))
      state.settings = { runtime, model, agentId, environmentId }
      await persist()
      return settings()
    }
    if (method === 'resources') {
      const { api } = await snapshot()
      const [agents, environments] = await Promise.all(['agents', 'environments'].map(k => api.inventory(k, signal)))
      return { agents: agents.map(({ id, name, description, runtime, model }) => ({ id, name, description, runtime, model: model?.id })),
        environments: environments.map(({ id, name }) => ({ id, name })) }
    }
    throw new Error('未知设置操作')
  }

  // Use the host's owner-authenticated, transport-independent /api route (including Desktop IPC).
  for (const method of ['settings', 'save', 'resources', 'catalog']) {
    const endpoint = 'agentapi-cloud.' + method
    ctx.connection.fetch.register({ path: '/api/' + endpoint, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return new Response(null, { status: 415 })
        const frame = await request.json()
        if (frame.type !== 'client-request' || frame.method !== endpoint) return new Response(null, { status: 400 })
        let result
        try { result = { ok: true, value: await rpc(method, frame.payload || {}, request.signal) } }
        catch (error) { result = { ok: false, error: { code: 'agentapi', message: error.message, details: {} } } }
        return Response.json({ type: 'server-response', rpcId: frame.rpcId, result }, { headers: { 'cache-control': 'no-store' } })
      },
    })
  }
}
