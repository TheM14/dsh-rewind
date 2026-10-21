// @xsj/dsh-rewind — client-half smoke test.
//
// Evaluates the REAL lib/client.js against stubs shaped like DSH 0.2.1-rc.2:
// the Factory slot that renders the user bubble, the `conversation`/`sessions`
// services, and only the ui-primitives members that build actually exports.
// The point is to fail here, not in the browser: a member that vanished from
// primitives, a slot key that no longer exists, or a registration shape the
// shell rejects would otherwise cost the whole user-row renderer at runtime.
//
// Run: node test/client-smoke.test.mjs   (no dependencies)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8')

let failed = 0
function check(label, got, want) {
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(52)} ${String(got).padEnd(10)} (want ${want})`)
}

// ------------------------------------------------------------- stubs ------
function element(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
}
const React = {
  createElement: element,
  Fragment: 'Fragment',
  useState: (init) => [init, () => {}],
  useRef: (init) => ({ current: init }),
  useLayoutEffect: () => {},
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

const registered = []
const injected = []
const slots = {
  register(options, component) { registered.push({ options, component }); return () => {} },
  inject(name, callback) { injected.push(name); callback(); return () => {} },
}
const primitives = {
  Tooltip: 'Tooltip',
  writeClipboard: () => Promise.resolve(true),
  IconCopyOutlineRegular: 'IconCopyOutlineRegular',
  IconCheckOutlineRegular: 'IconCheckOutlineRegular',
}
const requireStub = (id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${id}`)
}

const styleTags = []
const documentStub = {
  createElement: () => ({ setAttribute: () => {}, textContent: '', remove: () => {} }),
  head: { append: (tag) => styleTags.push(tag) },
  body: {},
  querySelector: () => null,
  querySelectorAll: () => [],
}
const win = {
  __ModuleLoader__: { load: ({ factory }) => { loaded = factory(requireStub) } },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
}
let loaded

const sandbox = new Function(
  'window', 'document', 'navigator', 'fetch', 'MutationObserver', 'File', 'setTimeout', 'clearTimeout', 'console',
  src,
)
sandbox(win, documentStub, { language: 'en-US' }, () => Promise.resolve({ json: () => Promise.resolve(null) }),
  function MutationObserver() { return { observe: () => {}, disconnect: () => {} } },
  function File() {}, () => 0, () => {}, { info: () => {}, warn: () => {}, error: () => {}, log: () => {} })

console.log('rewind client half — 0.2.1 contract smoke test\n')

check('bundle registers through __ModuleLoader__', typeof loaded, 'object')
check('exports apply', typeof loaded.apply, 'function')

const conversationCalls = []
const fakeCtx = {
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get: (name) => (name === 'slots' ? slots : undefined),
  slots,
}
loaded.apply(fakeCtx)

console.log('\nslot registrations')
check('declares exactly the slots it hard-requires', JSON.stringify(loaded.inject), JSON.stringify(['slots', 'sessions']))
check('waits for the chat node slot', injected.includes('conversation.chat.node'), true)
check('waits for the composer right slot', injected.includes('conversation.input.right'), true)
check('waits for the composer dock slot', injected.includes('conversation.input.dock'), true)
check('registers four entries', registered.length, 4)

const byKey = (name, field, value) => registered.find((r) => r.options.name === name && r.options[field] === value)
const userRow = byKey('conversation.chat.node', 'key', 'user')
const steeringRow = byKey('conversation.chat.node', 'key', 'steering')
check('user renderer shadows at priority -1', userRow.options.priority, -1)
check('steering renderer shadows at priority -1', steeringRow.options.priority, -1)
check('cancel entry is a list id', byKey('conversation.input.right', 'id', 'xsj-rewind-cancel') !== undefined, true)
check('banner entry is a list id', byKey('conversation.input.dock', 'id', 'xsj-rewind-banner') !== undefined, true)
check('css sheet installed and claimed', styleTags.length, 1)

console.log('\nuser row render')
let slotCalls = []
const props = {
  node: {
    key: 'user:2',
    data: {
      seq: 2,
      time: Date.now(),
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'text', text: '@file' },
        { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
        { type: 'file', attachment: { name: 'notes.md', bytes: 12 } },
        { type: 'tool-result', content: [] },
      ],
      referenceLabels: ['$session'],
      skillNames: ['demo'],
    },
  },
  sessionId: 's-1',
  loadImage: () => null,
  renderFactorySlot: (name, input) => { slotCalls.push({ name, input }); return { type: 'slot', name } },
}

let rendered
try {
  // The registered component is the slot wrapper; render the view it wraps so
  // the test exercises the actual row tree.
  const wrapper = userRow.component(props)
  rendered = wrapper.type(wrapper.props)
} catch (error) {
  console.log('  FAIL  renderer threw:', error.message)
  failed++
}

check('renderer produced a row', rendered && rendered.type, 'div')
check('bubble comes from the Factory slot', slotCalls.length, 1)
check('factory name', slotCalls[0] && slotCalls[0].name, 'conversation.chat.user.content')
check('text passed through', slotCalls[0] && slotCalls[0].input.content.text, 'hello @file')
check('images wrapped for the slot', JSON.stringify(slotCalls[0] && slotCalls[0].input.content.attachments[0]),
  JSON.stringify({ type: 'image', image: { attachment: { attachmentId: 'a1', mediaType: 'image/png' } } }))
check('files wrapped for the slot', JSON.stringify(slotCalls[0] && slotCalls[0].input.content.attachments[1]),
  JSON.stringify({ type: 'file', file: { name: 'notes.md', bytes: 12 } }))
check('unhandled blocks ride extraBlocks', slotCalls[0] && slotCalls[0].input.content.extraBlocks.length, 1)
check('reference labels reach the slot', JSON.stringify(slotCalls[0] && slotCalls[0].input.content.referenceLabels), JSON.stringify(['$session']))
check('interactive bubble', slotCalls[0] && slotCalls[0].input.interactive, true)

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
