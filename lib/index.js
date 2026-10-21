// @xsj/dsh-rewind — host half (permanent bundle plugin).
//
// Rewind a conversation to any user message:
//   1. mark: the client picks a `user/message` event seq. If the agent is
//      running, the live turn is interrupted. The pending mark lives in host
//      memory only — nothing is written to the log yet.
//   2. commit: the next turn that claims a real input message seals the hidden
//      range by appending an empty-content `developer/message` whose
//      `surfaceOp` replaces the surface nodes from the target through the tail.
//      The replacement projects to no LLM message, so the model sees the
//      truncated history while the append-only log keeps every event.
//   3. cancel: clears the pending mark — nothing was written, nothing sends.
//
// Why the surface replacement instead of patching `deriveMessages`:
//   - DSH 0.2.x re-derives history from the ordered surface, so a `replace`
//     operation is the harness's own truncation primitive (compaction uses it).
//     The log is self-describing: replaying it reproduces the truncation with no
//     plugin code, so a restart, a fork, or a reload needs no reconciliation.
//   - An empty-content developer message is dropped by `deriveEventMessage`, so
//     the cut injects no placeholder text into the model's context (a user-role
//     marker would).
//   - Nothing keeps a per-session override alive, so there is no patch to unwind
//     on disposal and no way to strand a filtered context across a reload.
//
// Durable state is the log itself: a committed range is derivable from the cut
// events, so the host keeps no private record type. Older builds appended
// `hook/invoked` records; that type is not part of a stock 0.2.x composition and
// an unknown, non-ignorable event makes the session log refuse to reopen, which
// is why this build never writes one.

export const name = 'xsj-rewind'
// `attachments` is deliberately NOT a hard dependency: the host half no longer
// reads image bytes (the client reads them through the session face), so a
// missing attachment provider cannot fail the plugin mount.
export const inject = ['webServer', 'sessions', 'agents']

const API = '/api/xsj-rewind'
const MAX_BODY_BYTES = 64 * 1024
// Bounded: a single-process host serves many sessions over its lifetime.
const MAX_TRACKED_SESSIONS = 64

// ------------------------------------------------------------------ http --
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

function writeJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function bodySeq(body) {
  const seq = body?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

// ---------------------------------------------------------------- events --
// Read helpers prefer the official accessors and fall back to the plain
// arrays so the plugin keeps working across host release lines.
function eventsOf(session) {
  return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
}

function eventAt(session, seq) {
  return typeof session.eventAt === 'function' ? session.eventAt(seq) : eventsOf(session)?.[seq]
}

function surfaceNodes(session) {
  const nodes = session.surface?.nodes
  return Array.isArray(nodes) ? nodes : []
}

// One committed rewind is an empty-content developer message that replaced a
// surface range. Both facts are checked: other producers (compaction) use
// replacements with content, and a real developer message always carries text.
function cutRangeOf(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type !== 'developer/message') return undefined
  const message = event.data?.message
  if (message === null || typeof message !== 'object') return undefined
  if (message.role !== 'developer') return undefined
  if (!Array.isArray(message.content) || message.content.length !== 0) return undefined
  const op = event.surfaceOp
  if (op === null || typeof op !== 'object' || op.op !== 'replace') return undefined
  if (typeof op.startSeq !== 'number' || typeof op.endSeq !== 'number') return undefined
  return { start: op.startSeq, end: op.endSeq }
}

function newId() {
  const crypto = globalThis.crypto
  if (crypto !== undefined && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `xsj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// ----------------------------------------------------------------- state --
// sid -> { pending: { targetSeq, markSeq } | null, ranges: {start,end}[],
//          scannedSeq }
export function apply(ctx) {
  const { sessions, agents, webServer } = ctx
  const states = new Map()

  function evictIfNeeded(protectedSid) {
    if (states.size <= MAX_TRACKED_SESSIONS) return
    for (const sid of Array.from(states.keys())) {
      if (states.size <= MAX_TRACKED_SESSIONS) return
      if (sid === protectedSid) continue
      states.delete(sid)
    }
  }

  function stateFor(sid) {
    let st = states.get(sid)
    if (st === undefined) {
      st = { pending: null, ranges: [], scannedSeq: 0 }
      states.set(sid, st)
      evictIfNeeded(sid)
    }
    return st
  }

  // Replay this session's cuts (incrementally) into memory. The log is the only
  // source of truth: a fresh process rebuilds every committed range here.
  //
  // A pending mark is process-local by design — its composer draft does not
  // survive a restart — so nothing is replayed into `pending`.
  function rebuild(session, st) {
    const events = eventsOf(session) ?? []
    for (let i = st.scannedSeq; i < events.length; i++) {
      const range = cutRangeOf(events[i])
      if (range !== undefined) st.ranges.push(range)
    }
    st.scannedSeq = events.length
  }

  function inRanges(seq, ranges) {
    return ranges.some((r) => seq >= r.start && seq <= r.end)
  }

  function resolveSession(sid) {
    if (typeof sid !== 'string' || sid.length === 0) return undefined
    return sessions.get(sid)
  }

  // Seal the pending range: replace every surface node from the target to the
  // tail with one invisible developer message. Returns the sealed range, or
  // undefined when the target no longer exists on the surface (the pending mark
  // is dropped in that case — the user asked for a node that compaction or a
  // fork already removed).
  function sealRange(session, st, turn, step) {
    const pending = st.pending
    if (pending === null) return undefined
    const nodes = surfaceNodes(session)
    const index = nodes.indexOf(pending.targetSeq)
    if (index < 0) {
      st.pending = null
      console.warn(`[xsj-rewind] target seq ${pending.targetSeq} is no longer on the surface; dropping the pending rewind`)
      return undefined
    }
    const start = nodes[index]
    const end = nodes[nodes.length - 1]
    const shadowed = nodes.slice(index)
    session.append('developer/message', {
      turn,
      step,
      message: {
        id: newId(),
        role: 'developer',
        content: [],
        // The cut is user-initiated and must stay a known source kind: an
        // unknown kind would leak into transcript consumers for no benefit,
        // since the shape already identifies a cut.
        source: { kind: 'user' },
      },
    }, {
      surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
      sourceEventSeqs: shadowed,
    })
    const range = { start, end }
    st.ranges.push(range)
    st.pending = null
    st.scannedSeq = session.seq
    return range
  }

  async function onMark(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body?.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const seq = bodySeq(body)
    if (seq === undefined) return writeJson(res, 400, { ok: false, error: 'bad seq' })
    const target = eventAt(session, seq)
    if (target === undefined || target.type !== 'user/message') {
      return writeJson(res, 400, { ok: false, error: 'target is not a user message' })
    }
    const st = stateFor(String(session.id))
    rebuild(session, st)
    if (inRanges(seq, st.ranges)) {
      return writeJson(res, 409, { ok: false, error: 'target is inside a committed hidden range' })
    }
    // The truncation is a surface operation, so the target must currently be a
    // model-visible node. A message already shadowed by compaction cannot be
    // rewound to, and saying so is better than failing at send time.
    if (!surfaceNodes(session).includes(seq)) {
      return writeJson(res, 409, { ok: false, error: 'target is not on the model surface' })
    }
    // No log record: the draft is editable and cancellable, so a pending mark is
    // UI state. `markSeq` lets the client notice the first row appended after it.
    const markSeq = typeof session.seq === 'number' ? session.seq : seq
    st.pending = { targetSeq: seq, markSeq }
    // Interrupt a running turn: its remaining output belongs to the abandoned tail.
    try {
      const agent = agents.get(session.id)
      if (agent !== undefined && agent.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (error) {
      console.error('[xsj-rewind] interrupt failed:', error)
    }
    const preview = typeof body?.preview === 'string' ? body.preview.slice(0, 120) : ''
    console.log(`[xsj-rewind] marked session ${String(session.id)} at user/message seq ${seq}${preview === '' ? '' : `: ${preview}`}`)
    writeJson(res, 200, { ok: true, targetSeq: seq, markSeq })
  }

  async function onCancel(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body?.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const st = stateFor(String(session.id))
    if (st.pending !== null) {
      const targetSeq = st.pending.targetSeq
      st.pending = null
      console.log(`[xsj-rewind] cancelled pending rewind of session ${String(session.id)} (was seq ${targetSeq})`)
    }
    writeJson(res, 200, { ok: true })
  }

  function onState(req, res) {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET only' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const session = resolveSession(url.searchParams.get('sessionId') ?? undefined)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const st = stateFor(String(session.id))
    rebuild(session, st)
    writeJson(res, 200, {
      ok: true,
      pending: st.pending === null ? null : { targetSeq: st.pending.targetSeq, markSeq: st.pending.markSeq },
      ranges: st.ranges.map((r) => ({ start: r.start, end: r.end })),
    })
  }

  const withErrLog = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      console.error('[xsj-rewind]', error?.stack || String(error))
      try {
        writeJson(res, 500, { ok: false, error: String(error?.message || error).slice(0, 120) })
      } catch { /* response already gone */ }
    }
  }
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/mark', handler: withErrLog(onMark) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/cancel', handler: withErrLog(onCancel) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/state', handler: withErrLog(onState) }))

  // Seal when a pending rewind's session next claims a real input message —
  // before the loop appends it and derives the request. The replacement covers
  // the surface as it stands, so the new message lands after it and stays
  // visible.
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload?.agent
      const st = agent?.id !== undefined ? states.get(String(agent.id)) : undefined
      if (st !== undefined && st.pending !== null && Array.isArray(payload.messages) && payload.messages.length > 0) {
        const range = sealRange(agent.session, st, payload.turn ?? 0, payload.step ?? 0)
        if (range !== undefined) {
          console.log(`[xsj-rewind] sealed session ${String(agent.id)}: hidden surface range [${range.start}, ${range.end}]`)
        }
      }
    } catch (error) {
      console.error('[xsj-rewind] seal failed:', error)
    }
    return next()
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent?.id === undefined) return
    states.delete(String(agent.id))
  })

  ctx.effect(() => () => {
    states.clear()
  })
}
