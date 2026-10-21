// @xsj/dsh-rewind — client half (permanent bundle plugin, no build step).
//
// Classic-script bundle contract: executing this file only REGISTERS the
// factory; the web module system materializes it once at mount. Externals
// (react, ui primitives) resolve through the shell's frozen module table.
//
// What the user sees:
//   - every user message row carries a rewind (↺) action beside copy;
//   - clicking it interrupts any running turn, hides that message and
//     everything after it, and pre-fills the composer (unsent, editable);
//   - while a rewind is pending, a ✕ button appears left of the send button
//     (cancel: restore the hidden rows, keep the draft, send nothing), plus a
//     banner above the composer explaining the state;
//   - after the next send, the tail stays hidden from both the chat view and
//     the model; the durable log keeps every event (see the host half).
//
// Hiding is pure DOM (inline display:none on the chat view's
// data-chat-flow-key rows), driven by the composer-mounted cancel entry
// (always present for the active session), so cancelling or switching
// sessions restores the untouched shipped UI.
//
// The row renderer shadows the shipped `user`/`steering` cells but delegates
// the bubble itself to the `conversation.chat.user.content` Factory slot, so
// text projection, @-references, images and file cards stay the shell's.

window.__ModuleLoader__.load({
  id: '@xsj/dsh-rewind',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var UiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')

    var API = '/api/xsj-rewind'
    var COMPOSER_INPUT = '[data-composer-input]'

    // ---------------------------------------------------------------- http --
    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json()).catch(() => null)
    }
    function get(path) {
      return fetch(API + path).then((r) => r.json()).catch(() => null)
    }

    // ------------------------------------------------------ content shapes --
    // Split one message's blocks the way the shipped bubble does: text, image
    // attachments, file attachments, then everything the generic block renders.
    function contentParts(content) {
      var texts = [], attachments = [], images = [], rest = []
      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var b = content[i]
          if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
          else if (b && b.type === 'image' && b.attachment !== undefined) {
            var source = { attachment: b.attachment }
            images.push(source)
            attachments.push({ type: 'image', image: source })
          } else if (b && b.type === 'file' && b.attachment !== undefined) attachments.push({ type: 'file', file: b.attachment })
          else rest.push(b)
        }
      }
      return { text: texts.join(''), attachments: attachments, images: images, rest: rest }
    }

    // ----------------------------------------------- per-session UI state --
    // { pending: null | { targetSeq, markSeq }, ranges: {start,end}[], version,
    //   fetched: bool, fetchFailed: bool }
    // `fetched` distinguishes "the host told us there are no ranges" from "we
    // have not heard back yet", so a cold load cannot flash a rewound tail.
    var MAX_TRACKED_SESSIONS = 24
    var states = new Map()
    var listeners = new Set()
    function readState(sid) { return states.get(sid) }
    function writeState(sid, mut) {
      var prev = states.get(sid)
      states.delete(sid)
      states.set(sid, {
        pending: mut && Object.prototype.hasOwnProperty.call(mut, 'pending') ? mut.pending : prev ? prev.pending : null,
        ranges: mut && Object.prototype.hasOwnProperty.call(mut, 'ranges') ? mut.ranges : prev ? prev.ranges : [],
        fetched: mut && Object.prototype.hasOwnProperty.call(mut, 'fetched') ? mut.fetched : prev ? prev.fetched : false,
        fetchFailed: mut && Object.prototype.hasOwnProperty.call(mut, 'fetchFailed') ? mut.fetchFailed : prev ? prev.fetchFailed : false,
        version: (prev ? prev.version : 0) + 1,
      })
      while (states.size > MAX_TRACKED_SESSIONS) {
        var oldest = states.keys().next()
        if (oldest.done) break
        states.delete(oldest.value)
      }
      Array.from(listeners).forEach((fn) => {
        try { fn() } catch (e) { console.error('[xsj-rewind]', e) }
      })
    }
    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }

    // =============================================== DOM-native driver ====
    // Per-session resync latch: a module-level flag would let one session's
    // in-flight /state read suppress another session's commit detection.
    var rwResyncing = new Set()
    function rwRows() {
      // The flow container is no longer unique (a Turn-process disclosure nests
      // its own `[data-chat-flow]`), so select rows document-wide: DOM order is
      // visual order, which is the only thing the bracketing logic needs.
      return Array.prototype.slice.call(
        document.querySelectorAll('[data-chat-flow-key], [data-chat-anchor-key]'))
    }
    function rwSeq(el) {
      var v = el.getAttribute('data-xsj-seq')
      if (v === null || v === '') return null
      var n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    // Only the `user`/`steering` renderers are shadowed by this plugin, so only
    // those rows are stamped with their seq. Every other kind — the model's
    // `assistant-step` output, tool calls, context rows — rendered through the
    // shipped renderer and stayed unstamped. A committed range therefore cannot
    // decide them directly: a hidden range is a contiguous span of the flow, and
    // the flow renders in seq order, so an unstamped row belongs to the side of
    // the nearest stamped row BEFORE it — that is what keeps an answer with the
    // prompt that produced it. A leading run with no evidence before it inherits
    // the following evidence; with no evidence at all it stays visible.
    function rwRowVerdicts(rows, ranges, targetIdx) {
      var verdicts = new Array(rows.length)
      for (var i = 0; i < rows.length; i++) {
        var seq = rwSeq(rows[i])
        if (seq === null) { verdicts[i] = null; continue }
        verdicts[i] = inRanges(seq, ranges) || (targetIdx >= 0 && i >= targetIdx)
      }
      return verdicts
    }
    function rwSolveVerdicts(verdicts) {
      var n = verdicts.length
      var before = new Array(n)
      var seen = null
      for (var i = 0; i < n; i++) {
        if (verdicts[i] !== null) seen = verdicts[i]
        before[i] = seen
      }
      var after = new Array(n)
      seen = null
      for (var j = n - 1; j >= 0; j--) {
        if (verdicts[j] !== null) seen = verdicts[j]
        after[j] = seen
      }
      var out = new Array(n)
      for (var k = 0; k < n; k++) {
        if (verdicts[k] !== null) { out[k] = verdicts[k]; continue }
        out[k] = before[k] !== null ? before[k] : after[k] === true
      }
      return out
    }
    function rwSetHidden(el, hide) {
      if (hide) {
        if (el.getAttribute('data-xsj-hidden') !== '1') {
          el.setAttribute('data-xsj-hidden', '1')
          el.style.setProperty('display', 'none', 'important')
        }
      } else if (el.getAttribute('data-xsj-hidden') === '1') {
        el.removeAttribute('data-xsj-hidden')
        el.style.removeProperty('display')
      }
    }
    function inRanges(seq, ranges) {
      return ranges.some((r) => seq >= r.start && seq <= r.end)
    }
    // Unhide every row this plugin hid. Only rows carrying the marker are
    // touched, so a row hidden by some other feature keeps its display value.
    function rwRestoreAll() {
      var marked = document.querySelectorAll('[data-xsj-hidden="1"]')
      for (var i = 0; i < marked.length; i++) rwSetHidden(marked[i], false)
    }
    function rwApply(sid) {
      var rows = rwRows()
      var st = readState(sid)
      // Before the host has answered for this session we know nothing about its
      // committed ranges. Deciding "all visible" here would flash the rewound
      // tail on every cold load, and a failed /state read would leave it visible
      // permanently — the UI disagreeing with the model's actual context. A
      // locally recorded pending mark is real state the host already
      // acknowledged, so it is still applied.
      var unfetched = !st || st.fetched !== true
      if (unfetched && (!st || st.pending == null)) {
        if (st && st.fetchFailed === true) rwRefetch(sid)
        return
      }
      var pending = st.pending
      var ranges = unfetched ? [] : (st.ranges || [])
      if (unfetched && st.fetchFailed === true) rwRefetch(sid)
      var targetIdx = -1
      if (pending) {
        for (var i = 0; i < rows.length; i++) { if (rwSeq(rows[i]) === pending.targetSeq) { targetIdx = i; break } }
      }
      var verdicts = rwSolveVerdicts(rwRowVerdicts(rows, ranges, targetIdx))
      for (var m = 0; m < rows.length; m++) {
        rwSetHidden(rows[m], verdicts[m] === true)
      }
      // Commit detection: a stamped row past the mark means the host sealed the
      // range (and the composer was cleared by the send), so re-read /state.
      if (pending && !rwResyncing.has(sid)) {
        var boundary = pending.markSeq || pending.targetSeq
        for (var q = Math.max(targetIdx + 1, 0); q < rows.length; q++) {
          var s2 = rwSeq(rows[q])
          if (s2 !== null && s2 > boundary) {
            rwResyncing.add(sid)
            get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
              rwResyncing.delete(sid)
              if (res) applyHostState(sid, res)
            }).catch(() => { rwResyncing.delete(sid) })
            break
          }
        }
      }
    }

    function applyHostState(sid, res) {
      if (!res || res.ok !== true) return
      writeState(sid, {
        pending: res.pending ? {
          targetSeq: res.pending.targetSeq,
          markSeq: typeof res.pending.markSeq === 'number' ? res.pending.markSeq : res.pending.targetSeq,
        } : null,
        ranges: Array.isArray(res.ranges) ? res.ranges : [],
        fetched: true,
        fetchFailed: false,
      })
    }
    function rwLoadState(sid) {
      return get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
        if (!res || res.ok !== true) return false
        applyHostState(sid, res)
        return true
      }).catch(() => false)
    }
    // One in-flight retry per session. The retry writes state only when the flag
    // actually changes: writeState bumps `version`, which re-runs the driver
    // effect, so an unconditional write on every failed retry would loop forever
    // against a host that stays down.
    var rwRetrying = new Set()
    function rwRefetch(sid) {
      if (rwRetrying.has(sid)) return
      var cur = readState(sid)
      if (cur && cur.fetched === true) return
      rwRetrying.add(sid)
      setTimeout(() => {
        rwRetrying.delete(sid)
        rwLoadState(sid).then((ok) => {
          if (ok) return
          var now = readState(sid)
          if (now && now.fetchFailed === true) return
          writeState(sid, { fetchFailed: true })
        })
      }, 2000)
    }

    // -------------------------------------------------------------- i18n --
    var zh = (typeof navigator !== 'undefined' ? navigator.language || '' : '').toLowerCase().indexOf('zh') === 0
    var L = zh ? {
      rewind: '回退到此消息',
      cancel: '取消回溯',
      copy: '复制',
      copied: '已复制',
      banner: '已回退到一条历史消息（其内容在输入框中，可编辑）。发送后将从此处继续，后续消息对模型不可见；点输入框右侧 ✕ 取消回溯。',
      failed: '回退失败',
    } : {
      rewind: 'Rewind to this message',
      cancel: 'Cancel rewind',
      copy: 'Copy',
      copied: 'Copied',
      banner: 'Rewound to an earlier message (its text is in the composer, editable). Sending continues from there and hides the tail from the model; click the ✕ left of Send to cancel.',
      failed: 'Rewind failed',
    }

    // ------------------------------------------------------------ helpers --
    function pad2(n) { return n < 10 ? '0' + n : String(n) }
    function fmtClock(time) {
      try {
        var d = new Date(time)
        var now = new Date()
        var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm
        return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm
      } catch (e) { return '' }
    }
    function svgIcon(paths) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, paths)
    }
    // The icon set is weight-suffixed; resolve across spellings so a newer host
    // never hands createElement an undefined component (which throws while
    // rendering the row and costs the whole nearest render boundary).
    function primitiveIcon(names) {
      for (var i = 0; i < names.length; i++) {
        if (typeof UiPrimitives[names[i]] === 'function') return UiPrimitives[names[i]]
      }
      return null
    }
    var COPY_ICON = primitiveIcon(['IconCopyOutlineRegular', 'IconCopyOutline16'])
    var CHECK_ICON = primitiveIcon(['IconCheckOutlineRegular', 'IconCheckOutline16'])
    function iconElement(component) {
      return component === null ? null : React.createElement(component, {})
    }
    var REWIND_ICON = svgIcon([
      React.createElement('path', { key: 'arc', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
      React.createElement('path', { key: 'head', d: 'M3 3v5h5' }),
    ])
    var CANCEL_ICON = svgIcon([
      React.createElement('path', { key: 'a', d: 'M18 6 6 18' }),
      React.createElement('path', { key: 'b', d: 'M6 6l12 12' }),
    ])
    function iconButton(tooltip, className, icon, handlers) {
      return React.createElement(UiPrimitives.Tooltip, { label: tooltip, side: handlers.side },
        React.createElement('button', {
          type: 'button', className, 'aria-label': tooltip, onClick: handlers.onClick,
          disabled: handlers.disabled,
        }, icon))
    }

    var BASE_CSS = [
      '.xsj-rw-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}',
      '.xsj-rw-actions{display:flex;align-items:center;gap:2px;height:28px;margin-top:4px;margin-left:-6px}',
      '.xsj-rw-clock{color:var(--dsw-alias-label-tertiary,#98a2b3);white-space:nowrap;padding-right:10px;font-size:14px;line-height:24px;font-variant-numeric:tabular-nums}',
      '.xsj-rw-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary,#98a2b3);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.xsj-rw-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,inherit)}',
      '.xsj-rw-action:disabled{opacity:.45;cursor:default}',
      '@media(hover:hover){[data-time-hover-root] .xsj-rw-clock,[data-time-hover-root] .xsj-rw-action{opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover .xsj-rw-clock,[data-time-hover-root]:hover .xsj-rw-action,[data-time-hover-root]:focus-within .xsj-rw-clock,[data-time-hover-root]:focus-within .xsj-rw-action{opacity:1}}',
      '@media(hover:hover){[data-time-hover-root] .xsj-rw-trigger{opacity:.55}[data-time-hover-root]:hover .xsj-rw-trigger{opacity:1}}',
      '.xsj-rw-cancel{width:28px;height:28px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.xsj-rw-cancel:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,60,60,.14));color:var(--dsw-alias-state-error-primary,#d44444)}',
      '.xsj-rw-banner{width:100%;max-width:min(var(--dsh-composer-card-max-width,780px),100%);box-sizing:border-box;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,inherit);border-radius:10px;padding:6px 12px;font-size:13px;line-height:20px;margin:0 auto 6px}',
      '.xsj-rw-banner-icon{flex:none;font-size:14px}',
    ].join('\n')

    // -------------------------------------------------------------- apply --
    function apply(ctx) {
      var slots = ctx && (ctx.get ? ctx.get('slots') : ctx.slots)

      function service(name) {
        try {
          return ctx && ctx.get ? ctx.get(name) : ctx ? ctx[name] : undefined
        } catch (e) {
          return undefined
        }
      }
      function scopeOf(sid) {
        try {
          var sessions = service('sessions')
          if (sessions !== undefined && typeof sessions.scope === 'function') return sessions.scope(sid)
        } catch (e) { /* scope unavailable */ }
        return undefined
      }
      function sessionFaceOf(sid) {
        try {
          var sessions = service('sessions')
          var binding = sessions !== undefined && typeof sessions.binding === 'function' ? sessions.binding(sid) : undefined
          return binding !== undefined && binding !== null ? binding.session : undefined
        } catch (e) { return undefined }
      }

      // Programmatic draft write. The shell's input machine owns the editor, so
      // reach it through `ctx.conversation.input.for(scope)` — the same route the
      // shipped command palette uses. A DOM write is the fallback for a shell
      // that has not published the service yet.
      function writeDraft(sid, text) {
        try {
          var conversation = service('conversation')
          var scope = scopeOf(sid)
          if (conversation !== undefined && conversation.input !== undefined && scope !== undefined
            && typeof conversation.input.for === 'function') {
            var input = conversation.input.for(scope)
            input.setDraft(text)
            if (typeof input.focus === 'function') input.focus()
            return true
          }
        } catch (e) {
          console.warn('[xsj-rewind] composer service write failed:', e)
        }
        return domWriteDraft(text)
      }

      function domWriteDraft(text) {
        var editable = document.querySelector(COMPOSER_INPUT)
        if (editable === null) {
          console.warn('[xsj-rewind] composer input not found — draft not refilled')
          return false
        }
        try {
          editable.focus()
          var selection = document.getSelection()
          if (selection !== null) {
            var range = document.createRange()
            range.selectNodeContents(editable)
            selection.removeAllRanges()
            selection.addRange(range)
          }
          var ok = false
          try { ok = document.execCommand('insertText', false, text) } catch (e) { ok = false }
          if (ok) return true
          editable.textContent = text
          editable.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        } catch (e) {
          console.error('[xsj-rewind] draft write failed:', e)
          return false
        }
      }

      // ------------------------------------------------- image re-attach --
      // Read each durable image's bytes through the session face (the same
      // authorization the transcript uses), turn them into Files, and hand them
      // to the composer's own draft registry so the shipped image limits and
      // previews apply instead of a bypass.
      var IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
      var reattachChain = Promise.resolve()

      function reattachImages(sid, images) {
        var list = Array.isArray(images) ? images : []
        if (list.length === 0) return Promise.resolve(0)
        reattachChain = reattachChain.then(() => reattachBatch(sid, list), () => reattachBatch(sid, list))
        return reattachChain
      }

      function reattachBatch(sid, list) {
        var conversation = service('conversation')
        var scope = scopeOf(sid)
        var session = sessionFaceOf(sid)
        if (conversation === undefined || scope === undefined || session === undefined
          || typeof conversation.createDrafts !== 'function' || typeof session.readAttachment !== 'function') {
          console.warn('[xsj-rewind] image restore unavailable (conversation services not ready)')
          return Promise.resolve(0)
        }
        var jobs = list.map((img, index) => {
          var ref = img && img.attachment ? img.attachment : null
          if (ref === null || ref.attachmentId === undefined) return null
          var id = String(ref.attachmentId)
          var mediaType = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
          var ext = IMAGE_EXT[mediaType]
          if (ext === undefined) return null
          var name = typeof ref.name === 'string' ? ref.name : 'image-' + (index + 1) + '.' + ext
          return session.readAttachment(id).then((result) => {
            if (!result || result.ok !== true || !result.value || result.value.data === undefined) return null
            return new File([result.value.data], name, { type: mediaType })
          }).catch(() => null)
        }).filter((job) => job !== null)
        return Promise.all(jobs).then((files) => {
          var real = files.filter((f) => f instanceof File)
          if (real.length === 0) return 0
          try {
            var drafts = conversation.createDrafts(sid, real)
            if (!Array.isArray(drafts) || drafts.length === 0) return 0
            var admitted = conversation.input.for(scope).addAttachments(drafts.map((d) => d.id))
            if (!admitted) {
              console.warn('[xsj-rewind] composer refused restored images (busy)')
              if (typeof conversation.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(drafts)
              return 0
            }
            return drafts.length
          } catch (e) {
            console.error('[xsj-rewind] image restore failed:', e)
            return 0
          }
        })
      }

      // --------------------------------------- user message node view ----
      // Faithful replacement for the shipped user/steering row: the bubble is
      // the shell's own `conversation.chat.user.content` Factory (text runs,
      // reference chips, images, file cards), and only the action row differs.
      function UserNodeView(props) {
        var node = props.node
        var data = node && node.data ? node.data : { content: [] }
        var parts = contentParts(data.content)
        var sid = props.sessionId
        var copiedState = React.useState(false)
        var copied = copiedState[0]
        var setCopied = copiedState[1]
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var rootRef = React.useRef(null)
        React.useLayoutEffect(() => {
          try {
            var el = rootRef.current
            if (!el || !el.closest) return
            var row = el.closest('[data-chat-flow-key]') || el.closest('[data-chat-anchor-key]')
            if (row && typeof data.seq === 'number' && row.getAttribute('data-xsj-seq') !== String(data.seq)) {
              row.setAttribute('data-xsj-seq', String(data.seq))
              window.dispatchEvent(new Event('xsj-rw-stamp'))
            }
          } catch (e) { /* stamping is best-effort */ }
        })

        function onCopy() {
          if (copied) return
          UiPrimitives.writeClipboard(parts.text).then((ok) => {
            if (ok) setCopied(true)
          }).catch(() => { /* clipboard unavailable */ })
        }
        function onRewind() {
          if (busy) return
          setBusy(true)
          post('/mark', { sessionId: sid, seq: data.seq, preview: parts.text.slice(0, 120) }).then((res) => {
            if (res && res.ok === true) {
              writeState(sid, { pending: {
                targetSeq: data.seq,
                markSeq: typeof res.markSeq === 'number' ? res.markSeq : data.seq,
              } })
              writeDraft(sid, parts.text)
              if (parts.images.length > 0) {
                reattachImages(sid, parts.images).catch((e) => {
                  console.error('[xsj-rewind] image reattach failed:', e)
                })
              }
            } else {
              console.error('[xsj-rewind] mark rejected:', res && res.error)
            }
          }).catch((e) => {
            console.error('[xsj-rewind] mark failed:', e)
          }).then(() => { setBusy(false) })
        }

        var referenceLabels = Array.isArray(data.referenceLabels) ? data.referenceLabels : []
        var skillNames = Array.isArray(data.skillNames) ? data.skillNames : []
        var body = typeof props.renderFactorySlot === 'function'
          ? props.renderFactorySlot('conversation.chat.user.content', {
            content: {
              text: parts.text,
              attachments: parts.attachments,
              extraBlocks: parts.rest,
              referenceLabels: referenceLabels,
            },
            loadImage: props.loadImage,
            facts: { sessionLabels: referenceLabels, skillNames: skillNames },
            interactive: true,
          })
          : null

        var actionsChildren = []
        if (typeof data.time === 'number') {
          actionsChildren.push(React.createElement('span', { key: 'clock', className: 'xsj-rw-clock' }, fmtClock(data.time)))
        }
        actionsChildren.push(iconButton(copied ? L.copied : L.copy, 'xsj-rw-action',
          copied ? iconElement(CHECK_ICON) : iconElement(COPY_ICON),
          { onClick: onCopy, side: 'bottom' }))
        actionsChildren.push(iconButton(L.rewind, 'xsj-rw-action xsj-rw-trigger', REWIND_ICON,
          { onClick: onRewind, disabled: busy, side: 'bottom' }))

        return React.createElement('div', { className: 'xsj-rw-row', 'data-time-hover-root': true, ref: rootRef },
          body,
          React.createElement('div', { key: 'actions', className: 'xsj-rw-actions' }, actionsChildren))
      }

      // ------------------------------------- cancel + css driver ----------
      // Mounted in the composer tool row for the active session: owns the host
      // state sync (attach + commit detection) and drives the row hiding.
      function CancelButton(props) {
        var sid = props.sessionId
        var st = React.useSyncExternalStore(subscribe, () => readState(sid))
        var pending = st && st.pending ? st.pending : null

        React.useEffect(() => {
          var live = true
          rwLoadState(sid).then((ok) => {
            if (live && !ok) writeState(sid, { fetchFailed: true })
          })
          return function () { live = false }
        }, [sid])

        React.useEffect(() => {
          var t = 0
          function schedule() {
            clearTimeout(t)
            t = setTimeout(() => { try { rwApply(sid) } catch (e) { console.error('[xsj-rewind] hide', e) } }, 150)
          }
          schedule()
          var obs = new MutationObserver(schedule)
          obs.observe(document.body, { childList: true, subtree: true })
          window.addEventListener('xsj-rw-stamp', schedule)
          return function () {
            clearTimeout(t)
            obs.disconnect()
            window.removeEventListener('xsj-rw-stamp', schedule)
            // Hiding is applied to the live DOM, so it must be undone on
            // teardown: a session switch or composer remount would otherwise
            // leave the last-painted rows hidden with no driver left.
            try { rwRestoreAll() } catch (e) { console.error('[xsj-rewind] restore', e) }
          }
        }, [sid, st ? st.version : 0])

        function onCancel() {
          post('/cancel', { sessionId: sid }).then((res) => {
            if (res && res.ok === true) writeState(sid, { pending: null })
          }).catch((e) => { console.error('[xsj-rewind] cancel failed:', e) })
        }

        if (pending === null) return null
        return iconButton(L.cancel, 'xsj-rw-cancel', CANCEL_ICON, { onClick: onCancel, side: 'top' })
      }

      function Banner(props) {
        var st = React.useSyncExternalStore(subscribe, () => readState(props.sessionId))
        var pending = st && st.pending ? st.pending : null
        if (pending === null) return null
        return React.createElement('div', { className: 'xsj-rw-banner' },
          React.createElement('span', { className: 'xsj-rw-banner-icon', 'aria-hidden': true }, '↺'),
          React.createElement('span', null, L.banner))
      }

      // ---------------------------------------------------------- mount ----
      var baseTag = document.createElement('style')
      baseTag.setAttribute('data-xsj-rewind', 'base')
      // Claim the tag for this bundle: an untagged `style:not([data-plugin])`
      // would be adopted by whichever plugin materializes next, and that
      // plugin's HMR replacement would delete this sheet with it.
      baseTag.setAttribute('data-plugin', '@xsj/dsh-rewind')
      baseTag.textContent = BASE_CSS
      document.head.append(baseTag)
      ctx.effect(() => () => baseTag.remove())

      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.warn('[xsj-rewind] slots service unavailable — renderer registration skipped')
        return
      }

      // Keyed slots throw on a duplicate same-key/same-priority registration
      // (e.g. a client HMR rebuild racing its own teardown). Guard every
      // registration so one failure cannot take down the others.
      var mounted = []
      function tryRegister(label, options, component) {
        try {
          var dispose = slots.register(options, component)
          mounted.push(label)
          return dispose
        } catch (e) {
          console.warn('[xsj-rewind] register failed for', label, (e && e.message) || e)
          return function () { /* nothing to dispose */ }
        }
      }

      ctx.effect(() => {
        var disposers = [
          // priority -1 beats the shipped renderer's default 0 (lowest renders),
          // so this plugin owns the row while mounted; unloading restores the
          // shipped one because its own registration was never removed.
          slots.inject('conversation.chat.node', () => [
            tryRegister('chat.node:user',
              { name: 'conversation.chat.node', key: 'user', priority: -1 },
              (props) => React.createElement(UserNodeView, props)),
            tryRegister('chat.node:steering',
              { name: 'conversation.chat.node', key: 'steering', priority: -1 },
              (props) => React.createElement(UserNodeView, props)),
          ]),
          slots.inject('conversation.input.right', () => {
            return tryRegister('input.right:cancel',
              { name: 'conversation.input.right', id: 'xsj-rewind-cancel', order: 90, label: L.cancel },
              (props) => React.createElement(CancelButton, props))
          }),
          slots.inject('conversation.input.dock', () => {
            return tryRegister('input.dock:banner',
              { name: 'conversation.input.dock', id: 'xsj-rewind-banner', order: 90, label: 'rewind' },
              (props) => React.createElement(Banner, props))
          }),
        ]
        if (mounted.length > 0) {
          console.info('[xsj-rewind] client mounted:', mounted.join(', '))
        }
        return () => {
          disposers.forEach((d) => {
            try { d() } catch (e) { /* stale disposer */ }
          })
        }
      })
    }

    exports.name = 'xsj-rewind'
    exports.inject = ['slots', 'sessions']
    exports.apply = apply
    return module.exports
  },
})
