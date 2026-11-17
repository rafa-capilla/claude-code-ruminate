import type { Register, EngineInterface } from 'claude-code'

const PREFIX = '~'
// '~~': to the last ruminator, the one working or, if none is, the last one, resumed as itself;
// '~~~': the same, with what happened here since pasted at its end first
const AGAIN = '~~'
const MERGE = '~~~'
// where the ruminators' answers, inboxes and the last ruminator's id live: the plugin's data folder,
// kept across updates; set at session.start
let DIR = ''
// the ruminator is another session: it loads this mod from here (--plugin-dir), with the installed
// one switched off so it is not loaded twice
let MOD_DIR = ''
const INSTALLED = 'ruminate@ruminate'
// plugins the ruminator starts with switched off: the disableInRuminator option
let OFF: string[] = []
const TIMEOUT_S = 15 * 60
const ING = 'ruminating'
const ED = 'ruminated'
// the same ruminators, called by the main session itself: the call blocks while the ruminator works,
// and the ruminator's answer comes back as the session's next words, which end its turn
const TOOL = 'ruminate'
const TOOL_FULL = 'mcp__ruminate__ruminate'
// what the call answers: the ruminator starts right after it, and this session never reads it
const CALLED = '.'
const NOTE = 'Your own note, through ruminate:'
const TOOL_SPEC = {
  name: TOOL,
  description: [
    'Think something over in the background, like a "~" prompt: it starts from everything up to',
    'this call (what you wrote and thought before it), works with its own tool calls, and its final',
    'answer comes back as your own next words, ending this turn. What it read and tried stays in',
    'its own transcript, not in this context. You are blocked while it works.',
    '"new" and "merge" take no `prompt`: say what you want before the call. "again" needs one, as',
    'it sees nothing from here.',
    'mode: "new" (default) starts fresh from here, like "~"; "again" resumes the last rumination',
    'on its own thread, like "~~"; "merge" resumes it after pasting in what happened here since,',
    'like "~~~". Use it in free turns to close a line of thought: read and think there, keep here',
    'only the conclusion. A wakeup can send another one later.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Only for again, and required there: it sees nothing from here' },
      mode: { type: 'string', enum: ['new', 'again', 'merge'], description: 'new (~), again (~~) or merge (~~~)' },
    },
  },
  isDeferred: false,
}

// sent: what the person typed mid-turn, passed on to the ruminator through its inbox
type Pending = { token: string; id?: string; sent: string[] }

const inboxOf = (p: Pending) => `${DIR}/${p.token}.inbox`
// the last ruminator's short id, kept on disk so a reload does not forget it
const lastOf = () => `${DIR}/last`

async function paths($: EngineInterface): Promise<void> {
  MOD_DIR = $.plugin.root
  DIR = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA
}

async function run($: EngineInterface, argv: string[]): Promise<string> {
  let out = ''
  for await (const c of $.process.spawn({ argv })) if (c.stream === 'stdout') out += c.text
  return out
}

// stops a ruminator and drops its answer file; never throws
async function drop($: EngineInterface, dir: string, p: Pending): Promise<void> {
  const id = p.id ?? ''
  await run($, ['sh', '-c', `claude stop ${id} ; claude rm ${id} ; rm -f ${dir}/${p.token}.*`]).catch(() => '')
}

// in a ruminator: how many inbox messages it has already taken
let taken = 0

// in a ruminator: what the person typed in the main session goes into its next request,
// the way a message typed mid-turn goes in between tool calls
async function take($: EngineInterface): Promise<void> {
  const inbox = await $.env.get('RUMINATE_INBOX')
  if (!inbox) return
  let sent: string[]
  try { sent = JSON.parse(await $.fs.read(inbox)) } catch { return }
  if (taken >= sent.length) return
  for (; taken < sent.length; taken++) {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: sent[taken] }] } })
  }
  await $.fs.write(`${inbox}.read`, String(taken))
}

// starts a ruminator with `prompt` as its message: forked from this session, or `resume`, an earlier
// ruminator's short id, carried on as itself (and, with `merge`, told what happened here since);
// its short id, or undefined if it did not start
async function launch($: EngineInterface, p: Pending, prompt: string, resume?: string, merge = false): Promise<string | undefined> {
  await run($, ['mkdir', '-p', DIR])
  let from = ['--resume', await $.session.id(), '--fork-session']
  if (resume) {
    // --resume takes the whole id: the transcript's file name
    const file = await run($, ['sh', '-c', `ls ~/.claude/projects/*/${resume}*.jsonl 2>/dev/null | head -1`])
    const full = file.trim().split('/').pop()?.replace(/\.jsonl$/, '')
    if (!full) return undefined
    // before resuming, what happened here since the ruminator last knew is pasted at its end
    if (merge) {
      const main = await $.session.id()
      const merged = await run($, ['sh', '-c',
        `python3 -I ${MOD_DIR}/hooks/merge.py ${file.trim()} "$(ls ~/.claude/projects/*/${main}.jsonl | head -1)" ${resume} 2>&1`])
      $.ui.log(`merged into ${resume}: ${merged.trim()}`)
    }
    from = ['--resume', full]
  }
  const settings = {
    enabledPlugins: Object.fromEntries([...OFF, INSTALLED].map((k) => [k, false])),
    env: { RUMINATE_INBOX: inboxOf(p) },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `cat > ${DIR}/${p.token}.json` }] }] },
  }
  const out = await run($, ['claude', '--bg', ...from,
    '--permission-mode', 'auto', '--plugin-dir', MOD_DIR, '--settings', JSON.stringify(settings), prompt])
  // --bg names the ruminator itself (it ignores --session-id): its short id is enough
  return out.match(/backgrounded\W+([0-9a-z-]+)/i)?.[1]
}

type Done = { last_assistant_message?: string }

// waits for the ruminator's Stop hook to write its answer; undefined on timeout; throws on Esc
async function wait($: EngineInterface, p: Pending): Promise<Done | undefined> {
  const path = `${DIR}/${p.token}.json`
  let done: Done | undefined
  for (let i = 0; i < TIMEOUT_S && !done; i++) {
    try { done = JSON.parse(await $.fs.read(path)) } catch { await run($, ['sleep', '1']) }
  }
  return done
}

// what the person typed that the ruminator never got to (no tool call came after it) goes to this
// session as usual
async function passOn($: EngineInterface, p: Pending): Promise<void> {
  if (!p.sent.length) return
  const read = Number(await $.fs.read(`${inboxOf(p)}.read`).catch(() => '0')) || 0
  const left = p.sent.slice(read)
  if (left.length) void $.prompt.submit({ text: left.join('\n\n') })
}

// a ruminator gets the tool too, so its tool list matches the main session's and it reads no
// gap as a fault; calling it there is denied (tool.call), as nesting ruminators is
async function offer($: EngineInterface): Promise<void> {
  await $.tool.register(TOOL_SPEC)
}

export const register: Register = (on, options) => {
  OFF = String(options.disableInRuminator ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  // the ruminator's answer to a ruminate call, waiting to be said as the next step
  let called: { mode: 'new' | 'again' | 'merge'; prompt: string } | undefined
  on('session.start', async ($, e, next) => {
    await paths($).catch(() => undefined)
    await offer($).catch(() => undefined)
    return next(e)
  })
  // the next main-loop turn.step is answered by a ruminator
  let pending: Pending | undefined
  // ruminators whose wait was cut by Esc: the aborted hook cannot spawn, so turn.complete stops them
  const cancelled: Pending[] = []
  // the ruminator the main turn is waiting on right now
  let running: Pending | undefined
  // whether the last main turn was cut by Esc: its dead prompt is then the transcript's last row
  let lastAborted = false
  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    if (e.agentId || await $.env.get('RUMINATE_INBOX')) return { deny: 'you are already ruminating' }
    const args = e as unknown as { prompt?: unknown; mode?: unknown }
    const prompt = String(args.prompt ?? '').trim()
    const mode = args.mode === 'again' || args.mode === 'merge' ? args.mode : 'new'
    if (!prompt && mode === 'again') return { deny: 'again needs a prompt: it sees nothing from here' }
    if (prompt && mode !== 'again') return { deny: `${mode} takes no prompt: what you wrote before the call is enough` }
    // the ruminator starts at the next step, once this call and its result are in the transcript:
    // a call left without a result is dropped on resume, with all the turn before it
    called = { mode, prompt }
    return { result: CALLED }
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) await take($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    // typed while the ruminator works: it is the ruminator's to read, not this session's
    const r = running
    if (r && e.turnId && !e.wait && e.origin.kind === 'composer' && !e.command) {
      const sent = e.text.startsWith(AGAIN) ? e.text.replace(/^~+/, '').trim() : e.text
      r.sent.push(sent)
      await $.fs.write(inboxOf(r), JSON.stringify(r.sent))
      // a prompt either enters or is dropped, and a dropped one stays in the box: empty it
      // by hand once the engine has put it back
      $.clock.after(0, () => { void $.prompt.fill({ text: '', mode: 'replace' }) })
      // the drop's reason goes to the status bar, one line: keep it short; the text, to the chat
      $.ui.log(`→ ruminator ${r.id ?? ''}: ${sent}`)
      return { drop: `→ ruminator ${r.id ?? ''}` }
    }
    if (e.origin.kind !== 'composer' || e.command || !e.text.startsWith(PREFIX)) return next(e)
    const merge = e.text.startsWith(MERGE)
    const again = merge || e.text.startsWith(AGAIN)
    const text = e.text.slice(merge ? MERGE.length : again ? AGAIN.length : PREFIX.length).trim()
    const p: Pending = { token: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sent: [] }
    pending = p
    // the last ruminator goes on with its own thread, whatever this session's last turn was
    if (again) {
      const last = (await $.fs.read(lastOf()).catch(() => '')).trim()
      if (last) p.id = await launch($, p, text, last, merge).catch(() => undefined)
      if (!p.id) $.ui.log(last ? `could not resume ${last}; starting fresh` : 'nothing to resume; starting fresh')
      if (p.id) return next({ ...e, text })
    }
    // no Esc before: the transcript ends on the live branch, so the ruminator starts from it now,
    // before this prompt is written, and gets the prompt itself as its message
    if (!lastAborted) p.id = await launch($, p, text).catch(() => undefined)
    return next({ ...e, text })
  })

  // fires on an aborted turn too, in a dispatch of its own that may spawn
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) lastAborted = e.isAborted
    if (!e.agentId) called = undefined
    if (!e.agentId && e.isAborted) {
      if (pending) { cancelled.push(pending); pending = undefined }
      while (cancelled.length) {
        const p = cancelled.shift()!
        if (!p.id) continue
        await drop($, DIR, p)
        $.ui.log(`cancelled ${p.id}`)
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // after a ruminate call: a ruminator answers this step, and the turn ends on it
    const c = called
    if (!e.agentId && c) {
      called = undefined
      const q: Pending = { token: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sent: [] }
      if (c.mode !== 'new') {
        const last = (await $.fs.read(lastOf()).catch(() => '')).trim()
        // resumed as itself the ruminator has not seen the call unless merged: it gets the prompt
        const msg = c.mode === 'merge' ? '.' : `${NOTE}\n\n${c.prompt}`
        if (last) q.id = await launch($, q, msg, last, c.mode === 'merge').catch(() => undefined)
        if (!q.id) $.ui.log(last ? `could not resume ${last}; starting fresh` : 'nothing to resume; starting fresh')
      }
      pending = q
    }
    const p = pending
    if (e.agentId || !p || (e.index !== 0 && !c)) return yield* next(e)
    pending = undefined
    let done: Done | undefined
    try {
      // after an Esc (or if it did not start at submit): the prompt is in the transcript by
      // now, hanging from the live branch; the fork starts from it, and '.' only sets it going
      if (!p.id) p.id = await launch($, p, '.')
      if (!p.id) { $.ui.log('could not start; answering here'); return yield* next(e) }
      $.ui.log(`${ING} at ${p.id}`)
      await $.fs.write(lastOf(), p.id)
      running = p
      done = await wait($, p)
    } catch {
      running = undefined
      // Esc: the wait is cut; turn.complete (isAborted) stops the ruminator
      // rethrowing would leave the abort reason ('user-cancel') as an answer
      cancelled.push(p)
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    running = undefined
    await passOn($, p)
    if (!done) {
      $.ui.log(`${p.id} did not answer in time; answering here`)
      await drop($, DIR, p)
      return yield* next(e)
    }
    await drop($, DIR, p)
    const answer = `${ED} at ${p.id}\n\n${done.last_assistant_message ?? ''}`
    yield { kind: 'text', index: 0, text: answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })
}
