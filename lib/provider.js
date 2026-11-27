import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { submitCloud, observe, consume, sessionURL, statusText, terminal } from './run.js'
import { inputFiles, selectedAttachments } from './inputs.js'
import { readUsage, turnUsage } from './usage.js'
import { resourceResolver } from './agentapi.js'
import { liveEvents, textChunks } from './stream.js'
import { cloudTurnControl, lastHumanId, pausedForParent } from './turn-control.js'

const route = 'agentapi-cloud'
const assignmentKey = text => createHash('sha256').update(text.trim()).digest('hex')

function stoppedReceipt(task) {
  return { id: task.id, name: 'cloud-' + task.id.slice(0, 8), accepted: false, reason: 'stopped_by_user' }
}

function deliveryLinks(task, files) {
  const names = files.map(f => f.name).join('、')
  return (names ? '\n\n文件：' + names : '') + '\n\n[查看云端记录](' + sessionURL(task.sessionId) + ')'
}

async function reconcileTurn(api, task, options) {
  // A previous host may have saved the idle event but never finished collecting.
  // Replay from the accepted input so we see the first end of this specific turn.
  task.cursor = task.inputSeq == null ? undefined : task.inputId
  task.status = 'running'
  task.reason = ''
  await observe(api, task, options)
  task.sending = false
}

export function view(task) {
  const { id, title, status, agent, runtime, model, environment, summary, reason, files, sessionId, usage } = task
  const receipt = { id, title, status, label: statusText[status] }
  for (const [key, value] of Object.entries({ agent, runtime, model, environment, summary, reason, files, sessionId, usage })) {
    if (value != null) receipt[key] = value
  }
  if (sessionId) receipt.portal = sessionURL(sessionId)
  return receipt
}

export function hostModule(name) {
  const root = process.env.DSH_INSTALL_DIR || (process.resourcesPath && join(process.resourcesPath, 'app.asar/dsh'))
  return createRequire(root ? join(root, 'package.json') : import.meta.url)(name)
}

export function remoteTools(session, pos, sdk, task) {
  const calls = new Map()
  function finish(call, text, error) {
    const message = sdk.createToolResultMessage({ callId: call.id, content: [{ type: 'text', text }], isError: error })
    session.append('tool/result', { ...pos, message }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  }
  return {
    accept(e) {
      const use = ['agent.tool_use', 'agent.mcp_tool_use'].includes(e.type)
      const result = ['agent.tool_result', 'agent.mcp_tool_result'].includes(e.type)
      if (!use && !result) return
      const key = e.tool_use_id || e.mcp_tool_use_id || e.id
      if (use) {
        const id = 'cloud-' + key, name = 'cloud_' + String(e.name || e.tool_name || 'tool').replace(/[^\w.-]/g, '_')
        let input = e.input ?? {}
        if (typeof e.input_json === 'string') {
          try { input = JSON.parse(e.input_json) } catch { input = { preview: e.input_json } }
        }
        const args = JSON.stringify(input)
        const argumentsJSON = args.length > 4000 ? JSON.stringify({ preview: args.slice(0, 4000) }) : args
        const content = [{ type: 'tool-call', id, name, arguments: argumentsJSON }]
        const message = sdk.createAssistantMessage({ content, source: { provider: route, model: task.model } })
        const time = Date.now()
        const stream = [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'block-end', index: 0, block: content[0] },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ].map(chunk => ({ type: 'chunk', time, chunk }))
        session.append('assistant/message', { ...pos, message, stream }, { surfaceOp: 'append' })
        const event = session.append('tool/call', { ...pos, name, callId: id, arguments: argumentsJSON })
        calls.set(key, { id, seq: event.seq })
      } else if (calls.has(key)) {
        const text = (Array.isArray(e.content) ? e.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '') || '云端工具已返回'
        finish(calls.get(key), text.slice(0, 6000), !!e.is_error)
        calls.delete(key)
      }
    },
    close() { for (const call of calls.values()) finish(call, '本轮结束，未收到工具结果。', true); calls.clear() },
  }
}

// Only this child's actual human/parent input crosses the AgentAPI boundary.
// Host system prompts, tool responses, runtime context and other chats stay local.
function newMessages(history, lastId) {
  let start = 0
  if (lastId) {
    const pos = history.findIndex(m => m.id === lastId)
    if (pos >= 0) start = pos + 1
  }
  return history.slice(start).filter(m => m.role === 'user' && ['user', 'agent-message'].includes(m.source?.kind))
}

export function installCloud(ctx, { tasks, resources, snapshot, persist }, sdk = hostModule('@deepseek-ai/dsh-llm')) {
  const resolve = resourceResolver(resources, persist)
  // Creation options may contain a repository credential. Keep them out of the plugin's KV store.
  const pendingOptions = new WeakMap()
  const positions = new WeakMap()
  const active = new Map()
  function pause(task, kind) {
    task.pausedAtParentMessage = lastHumanId(ctx.agents.get(task.owner))
    if (kind === 'user') task.userStopped = true
  }
  // send_message belongs to DSH. A cancelled delivery cannot return a successful messageId.
  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== 'send_message' || !exec.agent) return next()
    const target = exec.arguments?.agent?.split?.('/').at(-1)
    const stopped = Object.values(tasks).find(task => task.owner === exec.agent.id &&
      (task.id === target || 'cloud-' + task.id.slice(0, 8) === target) && pausedForParent(task, exec.agent))
    if (!stopped) return next()
    const text = JSON.stringify(stoppedReceipt(stopped))
    return { isError: true, content: [{ type: 'text', text }],
      error: { message: '该子任务已按用户要求停止，本条消息未发送。', info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } } }
  })
  ctx.on('session/event', (session, event) => {
    const task = tasks[session.id]
    if (!task) return
    // A stop may precede the adapter, e.g. during context preparation.
    const ending = event.data.reason
    if (event.type === 'turn/end' && ending?.kind === 'aborted' && ['user', 'parent'].includes(ending.reason?.kind)) {
      pause(task, ending.reason.kind)
      if (!task.sending || ['completed', 'failed'].includes(task.status)) {
        task.sending = false
        task.status = 'cancelled'
        task.reason = '本轮已停止，可继续追问。'
        delete task.initialText
        delete task.initialAttachments
        task.lastMessage = newMessages(session.deriveMessages(), task.lastMessage).at(-1)?.id ?? task.lastMessage
      }
      void persist().catch(() => {})
    }
    if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-step' &&
        event.data.inserted.some(m => m.source?.kind === 'user')) active.get(session.id)?.steer()
    if (event.type === 'step/start') positions.set(session, event.data)
  })
  ctx.subagents.registerProvider({ name: route, inheritsParentContext: false,
    capabilities: { agentPreset: false, agentOptions: true, outputSchema: false, depthLimit: true },
    async prepareContinuable({ sessionId, cwd }) {
      const task = tasks[sessionId]
      if (!task) throw new Error('请通过 /cloud 或云端委派工具创建子会话。')
      task.cwd = cwd
      return {}
    },
  })

  async function* streamTurn(options) {
    const task = tasks[options.sessionId]
    if (!task?.nativeChild) throw new Error('这条执行路径只用于云端子会话。')
    if (options.purpose) {
      const chunks = textChunks()
      yield* chunks.complete('title', task.title)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const local = ctx.agents.get(task.id)
    const history = local.session.deriveMessages()
    const messages = newMessages(history, task.lastMessage)
    const parent = ctx.agents.get(task.owner)
    if (messages.length && pausedForParent(task, parent) && !messages.some(m => m.source.kind === 'user')) {
      throw new Error('用户已停止此云端智能体，收到新的用户指令后可继续。')
    }
    if (parent && !pausedForParent(task, parent)) {
      delete task.pausedAtParentMessage
      delete task.userStopped
    }
    const signal = options.signal || new AbortController().signal
    if (task.status === 'unconfirmed' && task.sending) {
      if (!task.inputId) throw new Error('上次提交缺少回执，请在 Portal 核对：' + sessionURL(task.sessionId))
      const { api } = await snapshot()
      const recovering = cloudTurnControl(local, task, api, { pause: kind => pause(task, kind), persist, replaying: true })
      active.set(task.id, recovering)
      try {
        await reconcileTurn(api, task, { changed: persist, signal, beforeWait: recovering.caughtUp })
        recovering.confirm()
      } catch (error) {
        task.status = 'unconfirmed'
        throw error
      } finally {
        recovering.close()
        active.delete(task.id)
        await persist()
      }
      signal.throwIfAborted()
    }
    if (!messages.length) {
      if (task.status === 'cancelled' || task.status === 'failed') throw new Error(task.reason || statusText[task.status])
      const chunks = textChunks()
      const receipt = task.status === 'completed' && task.sessionId ? deliveryLinks(task, task.files || []) : ''
      yield* chunks.complete('receipt', (task.summary || task.reason || '已处理本轮输入。') + receipt)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const { api } = await snapshot()
    const first = !!task.initialText && !task.lastMessage
    const body = first ? task.initialText : messages.flatMap(m => m.content.filter(p => p.type === 'text').map(p => p.text)).join('\n')
    const attached = first ? task.initialAttachments : messages.flatMap(m => m.content.filter(p => p.attachment))
    if (!first) {
      for (const m of messages.filter(m => m.source.kind === 'user')) attached.push(...mentionFiles(m.content))
    }
    const commit = first ? task.commit : undefined
    const input = commit ? body + '\n仓库快照为 source-' + commit + '.zip。以该版本为基线，将代码修改保存为 /mnt/session/outputs/changes.patch。' : body
    let baseline
    const previousOutputIds = (task.files || []).map(f => f.id)
    Object.assign(task, { lastMessage: messages.at(-1).id, status: 'preparing', summary: '', reason: '', interrupted: false,
      sending: false, inputId: undefined, inputSeq: undefined, cursor: undefined })
    const chunks = textChunks()
    const recorder = remoteTools(local.session, positions.get(local.session) || { turn: 1, step: 1 }, sdk, task)
    const control = cloudTurnControl(local, task, api, {
      pause: kind => pause(task, kind), persist,
    })
    active.set(task.id, control)
    try {
      await persist()
      signal.throwIfAborted()
      // Failed usage reads must not delay a stop or charge an older turn to this one.
      baseline = task.sessionId
        ? (await readUsage(api, task, AbortSignal.any([signal, AbortSignal.timeout(5000)])).catch(() => null)) ?? undefined
        : null
      signal.throwIfAborted()
      const files = await inputFiles(ctx.attachments, attached, commit, task.cwd, signal)
      const sessionOptions = pendingOptions.get(task)
      if (!task.sessionId && task.hasSessionOptions && !sessionOptions) {
        throw new Error('云端 Session 创建参数已过期，请从主会话重新分派。')
      }
      await submitCloud({ api, config: task.config, resolve, task, sessionOptions, input, files, signal, changed: persist })
      control.send()
      delete task.initialText
      delete task.initialAttachments
      const url = sessionURL(task.sessionId)
      let highest = -1
      for await (const e of liveEvents(api, task, signal, control.polling)) {
        if (e.type === 'cloud.interrupt_error') {
          yield* chunks.complete('interrupt-' + e.attempt, '\n' + e.message + '\n')
          continue
        }
        if (e.type === 'event_delta') {
          if (task.inputSeq != null) yield* chunks.add(e.event_id, e.delta?.content?.text)
          continue
        }
        if (!Number.isInteger(e.sequence_number) || e.processed_at == null || e.sequence_number <= highest) continue
        highest = e.sequence_number
        if (task.inputSeq == null && e.id !== task.inputId && e.type !== 'session.status_terminated') continue
        const prev = task.status
        consume(task, [e])
        if (e.id === task.inputId || prev !== task.status) await persist()
        if (task.inputSeq != null) {
          recorder.accept(e)
          if (e.type === 'agent.message') {
            const answer = (e.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
            yield* chunks.complete(e.id, answer)
          }
          if (task.status === 'waiting' && prev !== 'waiting') {
            yield* chunks.complete(e.id, '\n等待确认，请在 [Portal](' + url + ') 处理。\n')
          }
        }
        if (task.status === 'collecting' || terminal.has(task.status)) break
      }
      await observe(api, task, { signal, changed: persist })
      control.confirm()
      if (task.status === 'cancelled' && control.steering) {
        const usage = turnUsage(baseline, await readUsage(api, task, AbortSignal.timeout(5000)).catch(() => undefined))
        if (usage) yield { type: 'usage', usage }
        yield* chunks.end()
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (task.status !== 'completed') throw new Error(task.reason || statusText[task.status])
      const receipt = deliveryLinks(task, task.files.filter(f => !previousOutputIds.includes(f.id)))
      const usage = turnUsage(baseline, await readUsage(api, task, AbortSignal.timeout(5000)).catch(() => undefined))
      if (usage) yield { type: 'usage', usage }
      yield* chunks.complete('portal', receipt)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (e) {
      if (signal.aborted && ['user', 'parent'].includes(signal.reason?.kind)) {
        pause(task, signal.reason.kind)
      }
      if (task.status === 'collecting') {
        // The remote turn ended. Resume file collection on recovery without interrupting the Session.
        task.status = 'unconfirmed'
      } else if (signal.aborted && task.sending && task.sessionId && !terminal.has(task.status)) {
        task.status = 'cancelling'
        try {
          await persist()
          await api.send(task.sessionId, [{ type: 'user.interrupt' }])
          await observe(api, task, { changed: persist, signal: AbortSignal.timeout(45000) })
        } catch { task.status = 'unconfirmed' }
      } else if (!terminal.has(task.status)) {
        task.status = signal.aborted ? 'cancelled' : task.sending && !e.status ? 'unconfirmed' : 'failed'
      }
      if (task.sessionId && task.inputId) {
        const usage = turnUsage(baseline, await readUsage(api, task, AbortSignal.timeout(5000)).catch(() => undefined))
        const pos = positions.get(local.session)
        // DSH stops consuming chunks after abort. Its meter also accepts an accounting-only attempt.
        if (usage && pos) local.session.append('assistant/attempt', {
          turn: pos.turn, step: pos.step, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } }],
        })
      }
      task.reason = task.status === 'cancelled' ? '本轮已停止，可继续追问。' : e.message || statusText[task.status]
      throw e
    } finally {
      if (terminal.has(task.status) && task.status !== 'unconfirmed') task.sending = false
      if (task.sessionId) pendingOptions.delete(task)
      control.close()
      active.delete(task.id)
      recorder.close()
      await persist()
    }
  }

  class CloudAdapter extends sdk.LlmAdapter {
    stream(options) { return streamTurn(options) }
    providerRetryPolicy() {
      return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
    }
  }
  ctx.llm.registerAdapter([route], new CloudAdapter())

  async function dispatch(parent, { text, title, attachments = [], commit, sessionOptions = {} }, signal) {
    const key = assignmentKey(text)
    const stopped = Object.values(tasks).find(task => task.owner === parent.id && task.userStopped &&
      (task.assignmentKey === key || (title && title === task.sessionTitle)) && pausedForParent(task, parent))
    if (stopped) return stoppedReceipt(stopped)
    const { config } = await snapshot()
    const id = randomUUID()
    const label = '云端 · ' + (title || text).replace(/\s+/g, ' ').trim().slice(0, 50)
    const task = { id, title: label, sessionTitle: title ?? text.replace(/\s+/g, ' ').trim().slice(0, 50),
      nativeChild: true, owner: parent.id, assignmentKey: key, config, status: 'preparing', initialText: text,
      initialAttachments: attachments, commit, inputFiles: [], files: [] }
    if (Object.keys(sessionOptions).length) {
      pendingOptions.set(task, sessionOptions)
      task.hasSessionOptions = true
    }
    tasks[id] = task
    try {
      await persist()
      const name = 'cloud-' + id.slice(0, 8)
      await ctx.subagents.startActivation({ provider: route, childId: id, label,
        name, parent, agentOptions: { provider: route, model: 'managed-session' },
        prompt: [{ type: 'text', text }], signal, delivery: 'parent' })
      return { id, name, title: label, accepted: true,
        message: 'The DSH child accepted the assignment. Tell the user what you delegated. Its result will arrive in this conversation.' }
    } catch (e) { delete tasks[id]; await persist(); throw e }
  }
  dispatch.stop = async (task, parent) => {
    const current = active.get(task.id)
    task.pausedAtParentMessage = lastHumanId(parent)
    if (!current && task.status === 'unconfirmed' && task.sessionId && task.sending && task.inputId) {
      const { api } = await snapshot()
      // Inspect the old turn before interrupting a possibly newer Portal turn.
      const signal = AbortSignal.timeout(45000)
      try {
        await reconcileTurn(api, task, { signal, changed: persist, beforeWait: async () => {
          await api.send(task.sessionId, [{ type: 'user.interrupt' }], signal)
          task.status = 'cancelling'
        } })
      } catch (error) { task.status = 'unconfirmed'; task.reason = error.message }
    } else {
      ctx.subagents.interrupt(task.id, { kind: 'ancestor', agent: parent })
      if (current) await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000)
        current.settled.then(() => { clearTimeout(timer); resolve() })
      })
    }
    await persist()
    return view(task)
  }
  return dispatch
}

export function mentionFiles(parts) {
  const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n')
  const names = Array.from(text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'<>]+))/gu),
    m => m[1] || m[2] || m[3]).filter(path => /^(?:\/|\.\.?\/)/.test(path))
  return selectedAttachments([{ role: 'user', source: { kind: 'user' }, content: parts }], names)
}
