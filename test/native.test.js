import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { runInNewContext } from 'node:vm'
import { installCloud, remoteTools, view } from '../lib/provider.js'
import { liveEvents, sseEvents, textChunks } from '../lib/stream.js'
import { observe, submitCloud } from '../lib/run.js'

const signal = new AbortController().signal

test('dispatch returns a lossless JSON receipt as soon as the native child accepts', async () => {
  const tasks = {}
  let starts = 0
  const ctx = { on() {}, llm: { registerAdapter() {} }, subagents: { registerProvider() {},
    async startActivation(spec) {
      starts++
      assert.equal(tasks[spec.childId].owner, spec.parent.id)
      return { childId: spec.childId }
    } } }
  const dispatch = installCloud(ctx, { tasks, resources: {}, persist: async () => {},
    snapshot: async () => ({ config: {} }) }, { LlmAdapter: class {} })
  const receipt = await dispatch({ id: 'parent' }, { text: 'compute', title: 'test' }, signal)
  assert.equal(starts, 1)
  const { message, ...child } = receipt
  assert.deepEqual(child, { id: receipt.id, name: 'cloud-' + receipt.id.slice(0, 8), title: '云端 · test', accepted: true })
  assert.ok(message)
  for (const result of [receipt, view(tasks[receipt.id])]) assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('native tool history embeds a replayable assistant stream and correlates nonadjacent results', () => {
  const events = []
  const session = { append(type, data, intent) {
    const event = { type, data, intent, seq: events.length }
    events.push(event)
    return event
  } }
  const sdk = { createToolResultMessage: m => m, createAssistantMessage: m => m }
  const recorder = remoteTools(session, { turn: 2, step: 1 }, sdk, { model: 'example' })
  recorder.accept({ type: 'agent.tool_use', tool_use_id: 'a', name: 'Bash', input_json: '{"command":"echo 42"}' })
  recorder.accept({ type: 'agent.mcp_tool_use', id: 'b', name: 'lookup', input: { id: 7 } })
  recorder.accept({ type: 'agent.mcp_tool_result', mcp_tool_use_id: 'b', content: [{ type: 'text', text: 'found' }] })
  recorder.accept({ type: 'agent.tool_result', tool_use_id: 'a', content: [{ type: 'text', text: '42' }] })
  recorder.close()
  assert.equal(events.length, 6)
  const first = events[0].data
  assert.deepEqual(first.stream[1].chunk.block, first.message.content[0])
  assert.equal(JSON.parse(first.message.content[0].arguments).command, 'echo 42')
  assert.deepEqual(events.filter(e => e.type === 'tool/result').map(e => e.intent.sourceEventSeqs), [[3], [1]])

  // Exercise the shipped client registration against the actual provider envelopes.
  let projection
  const uiConversation = { events: { register: def => { projection = def } }, userText: { register() {} } }
  const ctx = { uiConversation, slots: { inject() {} }, effect() {} }
  const loader = { load: ({ factory }) => factory(() => ({})).apply(ctx) }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: loader } })
  assert.equal(projection.target, 'chat')
  const claim = (type, data) => projection.match[type]?.({ type, seq: 7, surfaceOp: 'append', data }) ?? null
  assert.equal(claim('assistant/message', first).exclusive, true)
  assert.equal(projection.buildViewNode(), null)
  for (const e of events.filter(e => e.type.startsWith('tool/'))) assert.equal(claim(e.type, e.data), null)
  assert.equal(claim('assistant/live-chunk', {}), null)
  for (const interrupted of [true, false]) {
    assert.equal(claim('assistant/message', { interrupted, message: { ...first.message, content: [{ type: 'text', text: 'done' }] } }), null)
  }
  assert.equal(claim('assistant/message', { message: { ...first.message, source: { provider: 'local' } } }), null)
})

test('split Unicode SSE previews reconcile with the committed answer once', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"白榆"}\r\n\r\n')
  const frames = await Array.fromAsync(sseEvents([bytes.slice(0, 17), bytes.slice(17)]))
  assert.deepEqual(frames, [{ text: '白榆' }])
  const stream = textChunks()
  const chunks = [...stream.add('msg', '白'), ...stream.complete('msg', '白榆')]
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '白榆')
  assert.deepEqual(chunks.at(-1).block, { type: 'text', text: '白榆' })
})

test('a dropped SSE connection recovers current-turn events without posting another prompt', async () => {
  let query
  const result = { id: 'tool', type: 'agent.tool_result', sequence_number: 10, processed_at: 'now' }
  const api = { fetcher: async () => { throw Error('offline') }, request: async path => {
    query = new URL(path, 'https://unit.test')
    return { data: [result] }
  } }
  const stream = liveEvents(api, { sessionId: 'ses_test', inputId: 'this-turn', inputSeq: 9 }, signal)
  assert.deepEqual((await stream.next()).value, result)
  await stream.return()
  assert.equal(query.searchParams.get('page'), 'this-turn')
})

test('an inspected open SSE finishes the child, returns its files and accepts a follow-up', async t => {
  const posts = []
  const history = []
  const task = { id: 'child', sessionId: 'remote', nativeChild: true, allowPolicyApplied: true,
    inputFiles: [], files: [], status: 'completed' }
  const session = { deriveMessages: () => history }
  let adapter
  const ctx = { on() {}, agents: { get: () => ({ session }) }, subagents: { registerProvider() {} },
    llm: { registerAdapter: (_, value) => { adapter = value } } }
  const server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const turn = posts.length
    for (const [i, event] of [
      { type: 'user.message', id: 'input-' + turn },
      { type: 'agent.message', content: [{ type: 'text', text: 'answer ' + turn }] },
      { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ].entries()) {
      res.write('data: ' + JSON.stringify({ id: 'event-' + i, sequence_number: turn * 10 + i,
        processed_at: 'now', ...event }) + '\n\n')
    }
    // Session SSE stays open for future turns.
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  let streamSignal
  const api = {
    async send(id, events) {
      assert.equal(id, 'remote')
      assert.equal(events[0].type, 'user.message')
      posts.push(events[0].input.parts[0].text)
      return { data: [{ id: 'input-' + posts.length }] }
    },
    async fetcher(_, options) {
      streamSignal = options.signal
      const response = await fetch('http://127.0.0.1:' + server.address().port, options)
      void response.clone().text().catch(() => {}) // Same second reader as the DSH network inspector.
      return response
    },
    async request(path) { assert.equal(path, 'sessions/remote'); return {} },
    async outputs() {
      assert.equal(streamSignal.aborted, true)
      return [{ id: 'file-' + posts.length, name: 'result-' + posts.length + '.csv' }]
    },
  }
  installCloud(ctx, { tasks: { child: task }, resources: {}, snapshot: async () => ({ api }), persist: async () => {} },
    { LlmAdapter: class {} })
  for (const text of ['compare these reports', 'group the differences by product']) {
    history.push({ id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const deadline = AbortSignal.timeout(2500)
    const chunks = await Array.fromAsync(adapter.stream({ sessionId: 'child', signal: deadline }))
    assert.equal(deadline.aborted, false, 'the adapter must finish without an external abort')
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    const blocks = chunks.filter(c => c.type === 'block-end').map(c => c.block.text)
    assert.deepEqual(blocks.slice(0, -1), ['answer ' + posts.length])
    assert.ok(blocks.at(-1).includes(task.files[0].name))
    assert.equal(task.status, 'completed')
    assert.equal(task.sending, false)
  }
  assert.deepEqual(posts, ['compare these reports', 'group the differences by product'])
})

test('a resumed child reconciles the accepted turn even if its saved cursor is already idle', async () => {
  let adapter
  const task = { id: 'child', sessionId: 'remote', nativeChild: true, status: 'unconfirmed', sending: true,
    inputId: 'original', inputSeq: 1, cursor: 'idle', lastMessage: 'original', files: [], inputFiles: [] }
  const session = { deriveMessages: () => [{ id: 'original', role: 'user', source: { kind: 'user' } }] }
  const local = { session, cancel: () => assert.fail('the cloud turn already finished') }
  const ctx = { on() {}, agents: { get: () => local }, subagents: { registerProvider() {} },
    llm: { registerAdapter: (_, value) => { adapter = value } } }
  const api = {
    async request(path) {
      assert.equal(new URL(path, 'https://unit.test').searchParams.get('page'), 'original')
      local.cancel({ kind: 'user' }) // A stop during replay must never interrupt a newer Portal turn.
      return { data: [
        { type: 'agent.message', id: 'result', sequence_number: 2, processed_at: 'now', content: [{ type: 'text', text: 'done' }] },
        { type: 'session.status_idle', id: 'idle', sequence_number: 3, processed_at: 'now', stop_reason: { type: 'end_turn' } },
        { type: 'session.status_running', id: 'later', sequence_number: 4, processed_at: 'now' },
      ] }
    },
    async outputs() { return [{ id: 'report', name: 'report.md' }] },
  }
  installCloud(ctx, { tasks: { child: task }, resources: {}, snapshot: async () => ({ api }), persist: async () => {} },
    { LlmAdapter: class {} })
  const chunks = await Array.fromAsync(adapter.stream({ sessionId: 'child', signal: AbortSignal.timeout(2500) }))
  assert.match(chunks.find(c => c.type === 'block-end').block.text, /done[\s\S]*report\.md/)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(task.status, 'completed')
  assert.equal(task.cursor, 'idle')
  assert.equal(task.sending, false)
})

test('a follow-up reuses the remote session and can stop after an SSE span cursor', async () => {
  const task = { sessionId: 'ses_test', inputFiles: [], status: 'preparing' }
  const changed = async () => {}
  const api = { send: async (id, events) => {
    assert.equal(id, task.sessionId)
    assert.equal(events[0].input.parts[0].text, 'remember?')
    return { data: [{ id: 'followup' }] }
  } }
  await submitCloud({ api, task, input: 'remember?', files: [], signal, changed })
  assert.equal(task.inputId, 'followup')
  Object.assign(task, { inputSeq: 7, cursor: 'last-span', status: 'cancelling' })
  api.request = async path => {
    const q = new URL(path, 'https://unit.test').searchParams
    assert.equal(q.get('page'), 'last-span')
    assert.equal(q.has('types'), false)
    return { data: [
      { id: 'stop', sequence_number: 10, type: 'user.interrupt', processed_at: 'now' },
      { id: 'idle', sequence_number: 11, type: 'session.status_idle', processed_at: 'now', stop_reason: { type: 'end_turn' } },
    ] }
  }
  await observe(api, task, { changed, signal })
  assert.equal(task.status, 'cancelled')
})

test('a native stop sends one remote interrupt and records the settled usage on the interrupted step', async () => {
  const control = new AbortController()
  const recorded = [], posted = []
  const session = { id: 'child', deriveMessages: () => [
    { id: 'old', role: 'user', source: { kind: 'user' }, content: [] },
    { id: 'new', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'wait' }] },
  ], append: (type, data) => recorded.push({ type, data }) }
  let adapter, observeStep, reads = 0
  const ctx = { on: (_, cb) => { observeStep = cb }, agents: { get: () => ({ session }) },
    llm: { registerAdapter: (_, value) => { adapter = value } }, subagents: { registerProvider() {} } }
  const files = [{ id: 'file_report', name: 'report.csv' }]
  const task = { id: session.id, sessionId: 'remote', nativeChild: true, status: 'completed', lastMessage: 'old', files }
  const api = {
    async request(path) {
      if (path === 'sessions/remote') return { usage: { output_tokens: ++reads === 1 ? 17 : 23 } }
      return { data: [
        { id: 'input', sequence_number: 4, type: 'user.message', processed_at: 'now' },
        { id: 'stop', sequence_number: 5, type: 'user.interrupt', processed_at: 'now' },
        { id: 'idle', sequence_number: 6, type: 'session.status_idle', stop_reason: { type: 'interrupted' }, processed_at: 'now' },
      ] }
    },
    async send(id, events) { posted.push(...events.map(e => e.type)); return { data: [{ id: 'input' }] } },
    async fetcher() { control.abort(); control.signal.throwIfAborted() },
  }
  installCloud(ctx, { tasks: { child: task }, resources: {}, snapshot: async () => ({ api }), persist: async () => {} },
    { LlmAdapter: class {} })
  observeStep(session, { type: 'step/start', data: { turn: 3, step: 1 } })
  await assert.rejects(Array.fromAsync(adapter.stream({ sessionId: 'child', signal: control.signal })), { name: 'AbortError' })
  assert.deepEqual(posted, ['user.message', 'user.interrupt'])
  assert.equal(task.status, 'cancelled')
  assert.deepEqual(task.files, [{ id: 'file_report', name: 'report.csv' }])
  assert.equal(task.usage.totalTokens, 23)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].type, 'assistant/attempt')
  assert.equal(recorded[0].data.turn, 3)
  assert.equal(recorded[0].data.stream[0].chunk.usage.totalTokens, 6)
})

test('a desktop stop waits for the input receipt and confirmed idle, even after a failed interrupt', async () => {
  const { cloudTurnControl } = await import('../lib/turn-control.js')
  const task = { sessionId: 'remote', status: 'submitting', sending: true }
  const nativeCalls = [], posts = []
  const proto = { cancel: (...args) => nativeCalls.push(args) }
  const local = Object.create(proto)
  const cause = { kind: 'user' }, options = { keepInbox: true }
  const control = cloudTurnControl(local, task, {
    async send(id, events) {
      posts.push([id, events[0].type])
      if (posts.length === 1) throw Error('offline')
    },
  }, { pause() {}, persist: async () => {} })
  local.cancel(cause, options)
  assert.equal(posts.length, 0)
  task.inputId = 'receipt'
  control.send()
  await Promise.resolve()
  assert.match(task.reason, /offline/)
  assert.equal(control.polling.aborted, true)
  local.cancel(cause, options)
  local.cancel(cause, options)
  assert.deepEqual(posts, Array(2).fill(['remote', 'user.interrupt']))
  control.confirm()
  assert.equal(nativeCalls.length, 0)
  task.status = 'cancelled'
  control.confirm()
  assert.deepEqual(nativeCalls, [[cause, options]])
  control.close()
  assert.equal(Object.hasOwn(local, 'cancel'), false)
})

test('a user stop cancels repeat delivery, leaves unrelated dispatch open and allows a new user follow-up', async () => {
  let intercept, onEvent, human = 'request-1'
  const parent = { id: 'parent', session: { deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, id: human },
    { role: 'user', source: { kind: 'subagent-settled' }, id: 'notice' },
  ] } }
  const task = { id: '12345678-child', owner: parent.id, sessionTitle: 'stock audit', sending: false, status: 'preparing' }
  const session = { id: task.id, deriveMessages: () => [] }
  const ctx = { on: (event, fn) => { if (event === 'tools/execute') intercept = fn; else onEvent = fn },
    agents: { get: () => parent }, llm: { registerAdapter() {} }, subagents: { registerProvider() {}, startActivation: async () => {} } }
  const dispatch = installCloud(ctx, { tasks: { [task.id]: task }, resources: {}, snapshot: async () => ({config: {}}), persist: async () => {} }, { LlmAdapter: class {} })
  onEvent(session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  const check = target => intercept({ name: 'send_message', agent: parent, arguments: { agent: target } }, () => 'sent')
  const delegate = title => dispatch(parent, { title, text: 'execute ' + title }, signal)
  assert.equal(task.status, 'cancelled')
  const cancelled = check('cloud-12345678')
  assert.equal(cancelled.error.info.code, 'ABORTED_BEFORE_DISPATCH')
  assert.equal(JSON.parse(cancelled.content[0].text).reason, 'stopped_by_user')
  assert.equal((await delegate('stock audit')).accepted, false)
  assert.equal(check('unrelated'), 'sent')
  assert.equal((await delegate('other work')).accepted, true)
  human = 'request-2'
  assert.equal((await delegate('stock audit')).accepted, true)
  assert.equal(check('cloud-12345678'), 'sent')
})
