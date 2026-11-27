import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

test('/cloud hands control back to the parent after a dispatch or follow-up', async t => {
  // The plugin normally resolves these two SDK modules from the Desktop installation.
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-'))
  const installed = process.env.DSH_INSTALL_DIR
  t.after(async () => {
    if (installed === undefined) delete process.env.DSH_INSTALL_DIR
    else process.env.DSH_INSTALL_DIR = installed
    await rm(root, { recursive: true, force: true })
  })
  for (const [name, source] of [
    ['dsh-llm', 'exports.LlmAdapter = class {}'],
    ['dsh-tools', 'exports.validateJsonSchemaValue = () => []'],
  ]) {
    const dir = join(root, 'node_modules', '@deepseek-ai', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.js'), source)
  }
  process.env.DSH_INSTALL_DIR = root

  const hooks = new Map(), tools = new Map(), guards = []
  const unit = { loadAll: async () => ({}), setGlobal: async () => {} }
  const agent = { id: 'parent', session: { deriveMessages: () => [] } }
  let activation
  await apply({
    storage: { backend: { get: () => ({ kv: { open: async () => unit } }) } },
    credentials: { readRecord: async () => ({ key: 'test' }) },
    agents: { get: () => agent }, effect() {}, llm: { registerAdapter() {} },
    on(name, fn) { hooks.set(name, [...(hooks.get(name) || []), fn]) },
    subagents: { registerProvider() {}, startActivation: async spec => { activation = spec } },
    tools: { register: def => tools.set(def.name, def), guard: fn => guards.push(fn) },
    systemPrompt: { section() {}, context() {} }, connection: { fetch: { register() {} } },
  })
  for (const claim of hooks.get('agent/inbox/claimed') || []) {
    claim({ agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '/cloud compare reports' }] } })
  }
  const exec = { agent, signal: new AbortController().signal, concludeTurn: () => assert.fail('parent turn was forced closed') }
  const receipt = await tools.get('agentapi_delegate').execute({ task: 'Compare the two reports' }, exec)
  assert.equal(activation.delivery, 'parent')
  assert.equal(receipt.accepted, true)
  assert.match(receipt.message, /[Tt]ell the user/)
  for (const [name, args] of [['send_message', { agent: receipt.name }], ['read', {}]]) {
    const call = { ...exec, name, arguments: args }
    for (const guard of guards) assert.equal(guard(call), undefined)
    const run = hooks.get('tools/execute').reduceRight((next, handler) => () => handler(call, next), () => 'delivered')
    assert.equal(await run(), 'delivered')
  }
})
