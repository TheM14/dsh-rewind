# @xsj/dsh-rewind

English | [简体中文](./README.md)

A conversation-rewind plugin for DSH (DeepSeek Harness). A permanent bundle
plugin with a host half and a web client half — zero dependencies, zero build
steps. The desktop app and `dsh web` run the same code and share one install
procedure.

## Features

- Every user message row gains a **↺ rewind** action beside the copy icon.
  Clicking it:
  - **interrupts the current turn** if the model is still thinking/streaming;
  - hides that message and everything after it from the chat view (as if the
    tail never happened);
  - pre-fills the composer with the message text — **unsent and editable**;
  - **re-attaches any images** that rode the message back into the composer
    (the client reads the original bytes through the session's own credential
    and feeds them through the official draft-attachment intake, so image
    count/size limits apply);
  - on the next send, the model only sees the truncated history (everything
    before the rewind point) plus your new message.
- While a rewind is pending:
  - a banner above the composer explains the state;
  - a **✕ "cancel rewind" button sits left of the send button** — clicking it
    restores the hidden messages, keeps your draft, and sends nothing.
- Once sent (rewind committed), the hidden tail never reappears in the chat
  view and never enters the model context again.
- Only user messages can be rewound; assistant messages have no rewind entry
  (the host validates the event type).

## Version compatibility

| Plugin | DSH | Status |
| --- | --- | --- |
| 2.5.0 | 0.2.1-rc.2 | Current — desktop app and `dsh web` |
| ≤ 2.4.0 | 0.1.x | Not compatible with 0.2.x |

0.2.x rewrote two contracts this plugin depends on, which is why older builds
lose the rewind button entirely on that line: user-bubble text moved from
`primitives.projectUserText` to the `conversation.chat.user.content` Factory
slot, and row components no longer receive `inputActions`. 2.5.0 rebuilds the
client half against the new contract and switches model-side truncation to the
harness's own surface replacement (see "How it works"). Stay on 2.4.0 if you
need the 0.1.x line.

## Install

```powershell
# desktop app (profile name: desktop):
dsh plugin --profile desktop add <absolute path to this repo>

# dsh web (profile name: web):
dsh plugin --profile web add <absolute path to this repo>

# then restart DSH / the desktop app and refresh the page
```

The command registers the package into the profile
(`~/.dsh/profiles/<name>/package.json`: `dependencies` + `dsh.profile.bundles`).
At boot the profile merges this package's `cordis.patch.yml`, inserting the host
plugin row; the web client scan then serves `lib/client.js` automatically. The
desktop app and `dsh web` use the same loader, so only the profile name differs.

## Uninstall

```powershell
dsh plugin --profile desktop remove @xsj/dsh-rewind
# restart DSH. Rewind records in session logs stay harmlessly (see "Log &
# recovery").
```

## How it works

- **Model-side truncation**: when a rewind commits, the host appends an
  **empty-content `developer/message`** whose `surfaceOp` is `replace`, covering
  the surface from the rewind point through the tail, with every shadowed node
  listed in `sourceEventSeqs`. An empty developer message derives no LLM
  message, so the model sees the truncated history while the log keeps every
  message.
  - No `deriveMessages()` patch and no custom event type: the truncation is part
    of the log itself, so replaying it (restart, fork, plugin reload) restores
    the same state with no reconciliation.
  - Each replacement bumps the surface `replaceGeneration`; the host uses that to
    start a new message series and re-send the system prompt, and it owns request
    header consistency.
- **Interrupt**: on mark, a running agent is cancelled with
  `agent.cancel({ kind: 'user' }, { keepInbox: true })`; queued messages survive
  and continue from the rewind point.
- **Commit point**: inside the `agent/pre-step` waterfall, the first step that
  claims a real input message appends the replacement; the new message lands
  afterwards and stays visible.
- **UI hiding**: purely DOM-driven — chat rows carry `data-chat-flow-key`; the
  client stamps each row with its seq and a MutationObserver applies inline
  `display:none` to hidden rows. Nothing depends on the host store's internal
  shape; cancelling or switching sessions restores everything without touching
  any shipped renderer.
  - Only `user` / `steering` rows are rendered by this plugin and can be stamped;
    model output, tool calls and context rows inherit the verdict of the nearest
    stamped row **before** them (a leading run with no evidence falls back to the
    evidence that follows).
  - Hiding writes to the live DOM, so teardown releases only the rows carrying
    this plugin's marker.
- **Rewind icon**: takes over the `user`/`steering` cells of
  `conversation.chat.node` at priority `-1` (the slot system's native
  shadowing). The bubble itself is rendered by the shipped
  `conversation.chat.user.content` Factory, so @-references, session chips,
  images and file cards stay the shell's; the plugin only adds the ↺ button.
- **Draft and images**: the draft is written through
  `ctx.conversation.input.for(scope).setDraft()` (the same entry the command
  palette uses), with a DOM fallback when the service is unavailable; images are
  read back with the session's `readAttachment()` and registered through
  `createDrafts()` + `addAttachments()`, so quotas and previews stay the shell's.
- **State**: a pending rewind lives in host memory only (the composer draft does
  not survive a process, so there is nothing to persist); committed ranges are
  derived from the log's replacement events at startup. The plugin writes no
  private record type.

## Security notes

- The three endpoints (`mark` / `cancel` / `state`) register on the dsh web
  server and therefore **follow dsh's own local-trust model**: `dsh web` and the
  desktop app listen on the loopback interface by default, so they are reachable
  from this machine only and do not pass through dsh's API authentication layer.
  If you bind dsh web to a routable address (e.g. `0.0.0.0`), these endpoints
  become reachable too — restrict them at the network layer (firewall or an
  authenticating reverse proxy) in that case.
- Image reads do not go through this plugin: the client calls the host's
  `readAttachment` with the current session's credential, so its authorization
  matches the transcript's (only attachments that session references).
- Limits: 64 KB request bodies; `seq` must be a safe non-negative integer; the
  target must be a `user/message` currently on the model-visible surface.
- The plugin collects and reports nothing; all state stays in the local session
  log.

## Log & recovery

- The session log (an append-only event stream) **never loses a message**.
- A commit only appends an empty-content `developer/message`
  (`surfaceOp: replace`); no unknown event type is ever written, so the log
  always opens on 0.2.x.
- After a process restart, surface replay rebuilds the same truncation:
  model-side and UI-side hiding stay consistent across restarts.
- The trajectory view does not render replaced copies; the rows after a rewind
  still exist there as original events. Audit the raw session log directly.

## Known limits

- The rewind target must still be on the model-visible surface. A message already
  shadowed by compaction is rejected up front instead of failing at send time.
- Rewinding does not restore workspace files.
- A pending rewind does not survive a process restart: the draft stays in the
  composer, but the pending state does not, which matches the design (the draft
  is the only carrier).

## Porting

The plugin has no npm dependencies: the host half uses only Node builtins and
injected services; the client half pulls `react` and
`@deepseek-ai/dsh-client-ui-primitives` from the shell's frozen module table via
`window.__ModuleLoader__`. Clone this repo on any machine and follow "Install".

## Tests

```powershell
node test/hiding.test.mjs          # row-hiding verdicts (pure DOM logic)
node test/client-smoke.test.mjs    # client registration/rendering under 0.2.1
# the host half needs the real @deepseek-ai/dsh-session (its lib/index.js, e.g.
# packages/core/session/lib/index.js in a source checkout, or any node_modules):
$env:DSH_SESSION_MODULE="<path>/lib/index.js"; node test/host.test.mjs
```

## License

[MIT](./LICENSE)
