import { setTimeout as sleep } from 'node:timers/promises'
import { allowTools, portal } from './agentapi.js'

export const terminal = new Set(['completed', 'cancelled', 'failed', 'unconfirmed'])
export const statusText = { preparing: '准备云端资源', submitting: '提交任务', running: '运行中', waiting: '等待你在 Portal 处理', cancelling: '正在停止', collecting: '收集产物', completed: '已完成', cancelled: '已停止', failed: '失败', unconfirmed: '请在 Portal 核对' }
export const sessionURL = id => portal + '/sessions/' + encodeURIComponent(id)

export function consume(task, events) {
  for (const e of events) {
    // Pending records may be returned again when committed. Never advance the cursor past one.
    if (e.processed_at == null) break
    if (e.type === 'user.message' && (!task.inputId || e.id === task.inputId)) {
      task.inputSeq = e.sequence_number
      task.inputId = e.id
    }
    task.cursor = e.id
    if (e.type === 'session.status_terminated') {
      task.status = 'failed'
      task.reason ||= '云端 Session 已终止'
      break
    }
    if (task.inputSeq == null || e.sequence_number <= task.inputSeq) continue
    if (e.type === 'user.interrupt') task.interrupted = true
    if (e.type === 'agent.message') {
      const text = (e.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
      if (text) task.summary = text.slice(0, 12000)
    }
    if (e.type === 'session.error') task.reason = String(e.error?.message || e.message || '云端执行错误').slice(0, 500)
    if (e.type === 'session.status_running' && task.status !== 'cancelling') task.status = 'running'
    if (e.type === 'session.status_idle') {
      const reason = e.stop_reason?.type
      if (reason === 'requires_action') task.status = 'waiting'
      else if (reason === 'interrupted' || (reason === 'end_turn' && task.interrupted)) task.status = 'cancelled'
      else if (reason === 'end_turn') task.status = 'collecting'
      else { task.status = 'failed'; task.reason ||= reason || '缺少停止原因' }
    }
    if (terminal.has(task.status) || task.status === 'collecting') break
  }
}

export async function observe(api, task, { changed, signal, wait = sleep, beforeWait }) {
  let failures = 0
  while (!terminal.has(task.status) && task.status !== 'collecting') {
    signal.throwIfAborted()
    // A cursor from SSE can name a tool or span. A filtered event list cannot resolve that cursor.
    const query = new URLSearchParams({ order: 'asc', limit: '100' })
    if (task.cursor) query.set('page', task.cursor)
    let delay = 1400
    try {
      const page = await api.request('sessions/' + task.sessionId + '/events?' + query, { signal })
      const before = JSON.stringify(task)
      consume(task, page.data)
      task.connectionIssue = ''
      if (before !== JSON.stringify(task)) await changed()
      if (page.next_page && page.data.at(-1)?.id === task.cursor) delay = 0
      failures = 0
    } catch (error) {
      if (signal.aborted || [400, 401, 403, 404].includes(error.status)) throw error
      task.connectionIssue = '暂时无法读取事件，正在重连'
      await changed()
      delay = Math.min(30000, 1500 * 2 ** Math.min(++failures, 5))
    }
    if (task.status !== 'collecting' && !terminal.has(task.status)) {
      if (beforeWait && !failures && delay && task.inputSeq != null) {
        await beforeWait()
        beforeWait = undefined
      }
      await wait(delay, undefined, { signal })
    }
  }
  if (task.status === 'collecting') {
    // Collection can lag behind end_turn. The Portal keeps the complete file list afterwards.
    for (const delay of [0, 1000, 2000, 3000]) {
      if (delay) await wait(delay, undefined, { signal })
      try {
        task.files = await api.outputs(task.sessionId, task.inputFiles, signal)
        task.connectionIssue = ''
        if (task.files.length) break
      } catch (error) {
        if (signal.aborted) throw error
        task.connectionIssue = '产物列表暂不可用，请在 Portal 查看'
      }
    }
    task.status = 'completed'
    await changed()
  }
}

async function createSession({ api, config, resolve, task, sessionOptions = {}, changed, signal }) {
  let { agent, environment_id, metadata, resources, vault_ids } = sessionOptions
  let defaultAgent, defaultEnvironment
  if (agent === undefined) {
    defaultAgent = await resolve(api, 'agents', config, signal)
    agent = { type: 'agent', id: defaultAgent.id, version: defaultAgent.version }
    if (!config.agentId) {
      agent.type = 'agent_with_overrides'
      agent.model = { id: config.model }
    }
  }
  if (typeof agent === 'string') agent = { type: 'agent', id: agent }
  if (!Object.hasOwn(agent, 'tools') && !defaultAgent) {
    const path = 'agents/' + encodeURIComponent(agent.id)
    defaultAgent = await api.request(path + (agent.version ? '?version=' + agent.version : ''), { signal })
    agent = { ...agent, version: defaultAgent.version }
  }
  const tools = Object.hasOwn(agent, 'tools') ? agent.tools : defaultAgent?.tools
  if (Array.isArray(tools) && tools.length) agent = { ...agent, type: 'agent_with_overrides', tools: allowTools(tools) }
  if (environment_id === undefined) {
    defaultEnvironment = await resolve(api, 'environments', config, signal)
    environment_id = defaultEnvironment.id
  }
  task.status = 'submitting'
  await changed()
  signal.throwIfAborted()
  // Read the receipt even if cancellation arrives after the POST.
  const session = await api.request('sessions', { body: {
    agent, environment_id, title: task.sessionTitle ?? task.title,
    metadata: metadata ?? { source: 'deepseek-harness', dsh_task: task.id }, resources, vault_ids,
  } })
  task.sessionId = session.id
  task.allowPolicyApplied = true
  const resolved = session.agent ?? defaultAgent
  task.agent = resolved?.name || (typeof agent === 'string' ? agent : agent.id)
  task.runtime = resolved?.runtime
  task.model = session.agent?.model?.id ?? agent.model?.id ?? defaultAgent?.model?.id
  task.environment = defaultEnvironment?.name || environment_id
  // AgentAPI gives each mounted file a new Session-scoped ID.
  for (const resource of session.resources ?? []) {
    if (resource.type === 'file' && resource.file_id) task.inputFiles.push(resource.file_id)
  }
  await changed()
}

export async function submitCloud({ api, config, resolve, task, sessionOptions, input, files, changed, signal }) {
  if (!task.sessionId) await createSession({ api, config, resolve, task, sessionOptions, changed, signal })
  // Upgrade older Sessions on their next user turn, without touching their Agent definition.
  if (task.nativeChild && !task.allowPolicyApplied) {
    const path = 'sessions/' + encodeURIComponent(task.sessionId)
    const session = await api.request(path, { signal })
    const tools = session.agent?.tools || []
    if (tools.length) await api.request(path, { body: { agent: { tools: allowTools(tools) } }, signal })
    task.allowPolicyApplied = true
    await changed()
  }
  const session = { id: task.sessionId }
  const parts = [{ type: 'text', text: input }]
  for (const file of files) {
    signal.throwIfAborted()
    const result = await api.file(session.id, file, signal)
    task.inputFiles.push(result.id)
    parts.push(file.image ? { type: 'image', source: { type: 'file', file_id: result.id } }
      : { type: 'file', file_id: result.id, name: file.name })
  }
  signal.throwIfAborted()
  task.sending = true
  await changed()
  const accepted = await api.send(session.id, [{ type: 'user.message', input: { parts } }])
  task.inputId = accepted.data[0].id
  task.status = 'running'
  await changed()
}

export async function executeCloud(options) {
  await submitCloud(options)
  await observe(options.api, options.task, options)
}
