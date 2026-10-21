// @xsj/dsh-rewind — host-half test: mark → seal → state, against a real session.
//
// Runs lib/index.js over a real @deepseek-ai/dsh-session instance and asserts the
// properties the client relies on:
//   - a mark writes NOTHING to the log (it is cancellable UI state);
//   - the next input message seals the tail with ONE invisible surface
//     replacement, and deriveMessages() loses the tail;
//   - the seal survives a replay from the log alone (a restart needs no state);
//   - /state reports the committed range and rejects an already-hidden target.
//
// The host packages are not dependencies of this plugin, so the test takes the
// session module from DSH_SESSION_MODULE (a path to its lib/index.js):
//
//   DSH_SESSION_MODULE=<dsh checkout>/node_modules/@deepseek-ai/dsh-session/lib/index.js \
//     node test/host.test.mjs
//
// Without the variable the test reports "skipped" and exits 0, so a bare
// `node test/host.test.mjs` stays usable in a checkout without the host tree.

import { apply } from '../lib/index.js'

const sessionModulePath = process.env.DSH_SESSION_MODULE
if (!sessionModulePath) {
  console.log('host tests skipped (set DSH_SESSION_MODULE to the @deepseek-ai/dsh-session entry)')
  process.exit(0)
}

const sessionUrl = sessionModulePath.startsWith('file:') ? sessionModulePath : 'file:///' + sessionModulePath.replace(/\\/g, '/')
const { Session } = await import(sessionUrl)

const MODEL = { kind: 'model', provider: 'test', model: 'test' }
const text = (t) => [{ type: 'text', text: t }]
let nextId = 0
const mid = () => `msg-${++nextId}`
const user = (t) => ({ id: mid(), role: 'user', content: text(t), source: { kind: 'user' } })
const assistant = (t) => ({ id: mid(), role: 'assistant', content: text(t), source: MODEL })

let failed = 0
function check(label, got, want) {
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(48)} ${String(got).padEnd(10)} (want ${want})`)
}

// ------------------------------------------------------------------- rig --
function makeRig(session) {
  const routes = new Map()
  const hooks = new Map()
  const ctx = {
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn) },
    get: () => undefined,
    sessions: { get: (id) => (String(id) === String(session.id) ? session : undefined) },
    agents: { get: () => undefined },
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => {} } },
  }
  apply(ctx)
  return { routes, hooks }
}

function fakeReq(method, url, body) {
  const listeners = {}
  const req = {
    method,
    url,
    on(event, fn) {
      if (listeners[event] === undefined) listeners[event] = []
      listeners[event].push(fn)
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    if (body !== undefined) for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify(body)))
    for (const fn of listeners.end ?? []) fn()
  })
  return req
}

function call(handler, method, url, body) {
  return new Promise((resolve) => {
    let status = 0
    const res = {
      writeHead(code) { status = code },
      end(payload) { resolve({ status, body: payload ? JSON.parse(payload) : undefined }) },
    }
    handler(fakeReq(method, url, body), res)
  })
}

async function preStep(rig, session, turn, step) {
  const handlers = rig.hooks.get('agent/pre-step') ?? []
  for (const handler of handlers) {
    await handler({ agent: { id: session.id, session }, messages: [user('next')], turn, step }, () => Promise.resolve({}))
  }
}

// ------------------------------------------------------------------- test --
console.log('rewind host half — mark/seal/state\n')

const s = Session.create('rewind-test')
s.append('user/message', user('first'), { surfaceOp: 'append' })
s.append('assistant/message', { turn: 0, step: 0, message: assistant('answer1'), stream: [] }, { surfaceOp: 'append' })
const u2 = s.append('user/message', user('second'), { surfaceOp: 'append' })
const a2 = s.append('assistant/message', { turn: 1, step: 0, message: assistant('answer2'), stream: [] }, { surfaceOp: 'append' })
const rig = makeRig(s)
const state = rig.routes.get('/api/xsj-rewind/state')
const mark = rig.routes.get('/api/xsj-rewind/mark')
const cancel = rig.routes.get('/api/xsj-rewind/cancel')
const q = (extra) => `/api/xsj-rewind/state?sessionId=${encodeURIComponent(s.id)}${extra}`

console.log('initial state')
let res = await call(state, 'GET', q(''))
check('no pending, no ranges', `${res.body.pending}|${res.body.ranges.length}`, 'null|0')

console.log('\nmark')
const before = s.seq
res = await call(mark, 'POST', '/api/xsj-rewind/mark', { sessionId: s.id, seq: u2.seq, preview: 'second' })
check('mark accepted', res.body.ok, true)
check('mark wrote nothing to the log', s.seq, before)
res = await call(state, 'GET', q(''))
check('pending target', res.body.pending.targetSeq, u2.seq)

console.log('\ncancel')
res = await call(cancel, 'POST', '/api/xsj-rewind/cancel', { sessionId: s.id })
check('cancel accepted', res.body.ok, true)
check('nothing written by cancel', s.seq, before)
res = await call(state, 'GET', q(''))
check('pending cleared', res.body.pending, null)

console.log('\nmark + send (pre-step seal)')
await call(mark, 'POST', '/api/xsj-rewind/mark', { sessionId: s.id, seq: u2.seq })
await preStep(rig, s, 2, 0)
check('exactly one event appended', s.seq, before + 1)
const cut = s.eventAt(before)
check('cut is a developer message', cut.type + '/' + cut.data.message.role, 'developer/message/developer')
check('cut content is empty', cut.data.message.content.length, 0)
check('cut replaces the tail', `${cut.surfaceOp.op}:${cut.surfaceOp.startSeq}-${cut.surfaceOp.endSeq}`, `replace:${u2.seq}-${a2.seq}`)
check('cut names every shadowed node', cut.sourceEventSeqs.join(','), `${u2.seq},${a2.seq}`)
check('model history truncated', s.deriveMessages().length, 2)
check('tail gone from the model', s.deriveMessages().map((m) => m.content[0].text).join('|'), 'first|answer1')

console.log('\nstate after seal')
res = await call(state, 'GET', q(''))
check('pending cleared by seal', res.body.pending, null)
check('committed range reported', JSON.stringify(res.body.ranges), JSON.stringify([{ start: u2.seq, end: a2.seq }]))

console.log('\nvalidation')
res = await call(mark, 'POST', '/api/xsj-rewind/mark', { sessionId: s.id, seq: u2.seq })
check('hidden target rejected', res.status, 409)
res = await call(mark, 'POST', '/api/xsj-rewind/mark', { sessionId: s.id, seq: a2.seq })
check('non-user target rejected', res.status, 400)
res = await call(mark, 'POST', '/api/xsj-rewind/mark', { sessionId: 'nope', seq: 0 })
check('unknown session rejected', res.status, 404)

console.log('\nreplay from the log alone')
const replay = Session.create('rewind-replay', [...s.snapshotEvents()])
check('replayed history truncated', replay.deriveMessages().map((m) => m.content[0].text).join('|'), 'first|answer1')
check('replayed surface hides the tail', replay.surface.nodes.join(','), `0,1,${before}`)

console.log('\nnew input after a seal stays visible')
replay.append('user/message', user('third'), { surfaceOp: 'append' })
check('new message visible', replay.deriveMessages().map((m) => m.content[0].text).join('|'), 'first|answer1|third')

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
