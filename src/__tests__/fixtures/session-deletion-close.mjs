// Isolated Bun controller over the production deletion path and real Node
// helper. Delay one original handle event; never replace its process/PID.
import assert from 'node:assert/strict'
import * as cp from 'node:child_process'
import {spyOn} from 'bun:test'
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const [repo, root, mode] = process.argv.slice(2)
assert(['normal', 'close', 'stdout', 'stderr'].includes(mode))
mkdirSync(join(root, 'config'))
const sdk = join(root, 'owned-sdk.mjs')
writeFileSync(sdk, 'import {writeFileSync} from "node:fs"; export async function deleteSession() { writeFileSync(process.env.CLAUDE_CONFIG_DIR+"/owned-node.json",JSON.stringify({pid:process.pid,node:process.version,bun:process.versions.bun??null})); }\n')
const original = cp.spawn
let child, replay, heldResolve, exitResolve
const held = new Promise(resolve => heldResolve = resolve)
const exited = new Promise(resolve => exitResolve = resolve)
const witness = {exitSeen: false, closeSeen: false, stdoutClosed: false, stderrClosed: false}
const observer = spyOn(cp, 'spawn').mockImplementation((...args) => {
  child = Reflect.apply(original, cp, args)
  child.once('exit', () => { witness.exitSeen = true; exitResolve() })
  child.once('close', () => witness.closeSeen = true)
  child.stdout.once('close', () => witness.stdoutClosed = true)
  child.stderr.once('close', () => witness.stderrClosed = true)
  if (mode !== 'normal') {
    const target = mode === 'close' ? child : child[mode]
    const emit = target.emit
    target.emit = function(event, ...values) {
      if (event === 'close' && !replay) {
        replay = () => { target.emit = emit; return emit.call(target, event, ...values) }
        heldResolve()
        return true
      }
      return emit.call(this, event, ...values)
    }
  }
  return child
})
const {sessionDeletionRuntime} = await import(pathToFileURL(join(repo, 'src/proxy/sessionLifecycle.ts')))
let outcome = 'pending', failure, premature = false
const deletion = sessionDeletionRuntime.deleteWithSdkChild({sessionId: 'owned-deletion', configDir: join(root, 'config'), projectDir: root},
  'owned-token', 1500, async () => {}, {storeDir: root, sdkModuleUrl: pathToFileURL(sdk).href})
deletion.then(() => outcome = 'fulfilled', error => { outcome = 'rejected'; failure = error.message })
const deadline = setTimeout(() => { child?.kill('SIGKILL'); throw Error('Deletion fixture deadline') }, process.platform === 'win32' ? 60000 : 8000)
try {
  if (mode !== 'normal') {
    await held; await exited
    await new Promise(resolve => setTimeout(resolve, 100))
    premature = outcome !== 'pending'
    assert.equal(outcome, 'pending', 'Deletion completed before its original child/pipe close witness')
  }
} finally {
  replay?.()
  await deletion.catch(() => undefined)
  // Let the original close listeners run before recording or disposing state.
  await new Promise(resolve => setTimeout(resolve, 20))
  clearTimeout(deadline); observer.mockRestore()
  const native = JSON.parse(readFileSync(join(root, 'config', 'owned-node.json'), 'utf8'))
  assert.equal(native.pid, child.pid); assert.equal(native.bun, null)
  console.log('DELETION_CLOSE_REPORT ' + JSON.stringify({mode, outcome, failure, premature, witness,
    native, sdkDeleteCallsUseOwnedModule: true, modelCalls: 0}))
}
assert.equal(outcome, 'fulfilled', failure)
assert(Object.values(witness).every(Boolean), 'Original native helper and captured pipes did not join')
