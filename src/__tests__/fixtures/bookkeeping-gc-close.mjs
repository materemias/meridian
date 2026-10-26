// Real native SQLite ownership and public opaque close. The GC's original
// custom work or real Node close witness deliberately outlives its deadline.
import assert from 'node:assert/strict'
import * as cp from 'node:child_process'
import * as fsPromises from 'node:fs/promises'
import {spyOn} from 'bun:test'
import {mkdirSync, writeFileSync, realpathSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const [repo, root, mode] = process.argv.slice(2)
assert(['custom', 'native', 'admission'].includes(mode))
const directory = join(root, 'sessions')
mkdirSync(directory, {mode: 0o700}); mkdirSync(join(root, 'native'), {mode: 0o700})
Object.assign(process.env, {MERIDIAN_SESSION_DIR: directory, MERIDIAN_CONFIG_DIR: join(root, 'config'),
  MERIDIAN_BOOKKEEPING: 'sqlite', MERIDIAN_CREDENTIALS_READONLY: '1'})
const {setSessionStoreDir} = await import(join(repo, 'src/proxy/sessionStore.ts'))
setSessionStoreDir(directory)
const {initializeProxyBookkeeping} = await import(join(repo, 'src/proxy/session/bookkeeping/embedding.ts'))
const {SessionDeletionCleanupOwner, hasPendingSessionDeletionCleanup} = await import(join(repo, 'src/proxy/session/deletionCleanup.ts'))
const {acquireMaintenanceGuard} = await import(join(repo, 'src/proxy/session/bookkeeping/guard.ts'))
const {BookkeepingBusyError, BookkeepingMaintenanceRequiredError} = await import(join(repo, 'src/proxy/session/bookkeeping/storagePaths.ts'))
const {activeStoreBackend} = await import(join(repo, 'src/proxy/session/bookkeeping/storeBackend.ts'))
const {retainedBookkeepingRuntimeDirectory} = await import(join(repo, 'src/proxy/session/bookkeeping/runtimeIdentity.ts'))
const lifecycle = await import(join(repo, 'src/proxy/sessionLifecycle.ts'))
const outer = await initializeProxyBookkeeping()
assert(outer)
const owner = new SessionDeletionCleanupOwner(), sibling = new SessionDeletionCleanupOwner()
const sdk = join(root, 'owned-sdk.mjs')
writeFileSync(sdk, 'export async function deleteSession() {}\n')
const options = {storeDir: directory, preparedGraceMs: 0, retiredGraceMs: 0,
  deletionTimeoutMs: mode === 'custom' ? 50 : process.platform === 'win32' ? 1000 : 250,
  sdkModuleUrl: pathToFileURL(sdk).href}
let release, releaseAdmission, admissionReached, replay, child, observedClose = false, observer, mkdirObserver, gcWork
let nativeDeletionChildren = 0, peerRecovery
const custom = new Promise(resolve => release = resolve)
const admitted = new Promise(resolve => admissionReached = resolve)
const admission = new Promise(resolve => releaseAdmission = resolve)
if (mode === 'custom') options.deleter = () => custom
else {
  const original = cp.spawn
  observer = spyOn(cp, 'spawn').mockImplementation((...args) => {
    nativeDeletionChildren++
    child = Reflect.apply(original, cp, args)
    child.once('close', () => observedClose = true)
    if (mode === 'native') {
      const emit = child.emit
      child.emit = function(event, ...values) {
        if (event === 'close' && !replay) { replay = () => { child.emit = emit; return emit.call(child, event, ...values) }; return true }
        return emit.call(this, event, ...values)
      }
    }
    return child
  })
}
if (mode === 'admission') {
  const original = fsPromises.mkdir
  mkdirObserver = spyOn(fsPromises, 'mkdir').mockImplementation(async (...args) => {
    if (args[0] === join(directory, 'deletion-gates')) { admissionReached(); await admission }
    return Reflect.apply(original, fsPromises, args)
  })
}
let closeOutcome = 'pending', closeError, joinOutcome = 'pending', before, after
const snapshot = () => {
  let guardAvailable = false
  try { const guard = acquireMaintenanceGuard(directory); guardAvailable = true; guard.close() }
  catch (error) { assert(error instanceof BookkeepingBusyError || error instanceof BookkeepingMaintenanceRequiredError) }
  return {guardAvailable, portsInstalled: Boolean(activeStoreBackend()),
    identityRetained: retainedBookkeepingRuntimeDirectory() === realpathSync.native(directory),
    cleanupPending: hasPendingSessionDeletionCleanup(directory)}
}
try {
  const locator = await lifecycle.prepareFork({sessionId: 'owned-gc-close', configDir: join(root, 'native'), projectDir: root}, options)
  await lifecycle.abandonFork(locator, options)
  gcWork = owner.run(() => lifecycle.runGc([], options))
  void gcWork.catch(() => undefined)
  if (mode === 'admission') await admitted
  else assert.deepEqual(await gcWork, {deleted: 0, notFound: 0, failed: 0, deferred: 1})
  if (mode === 'native') {
    const peer = cp.spawnSync(process.execPath, ['--preload', join(repo, 'src/__tests__/fixtures/bookkeeping-engine-preload.mjs'), join(repo, 'src/__tests__/fixtures/bookkeeping-gc-peer-reconcile.mjs'), repo, directory], {
      env: process.env, encoding: 'utf8', timeout: process.platform === 'win32' ? 60000 : 10000,
    })
    assert.equal(peer.status, 0, peer.stderr)
    peerRecovery = JSON.parse(peer.stdout.split('\n').find(line => line.startsWith('PEER_RECONCILE ')).slice('PEER_RECONCILE '.length))
    assert.equal(peerRecovery.deletingRecovered, 0, 'A peer recovered the live original owner before its child and pipes joined')
    assert.equal((await lifecycle.reconcile([], options)).deletingRecovered, 0)
    assert.deepEqual(await owner.run(() => lifecycle.runGc([], options)), {deleted: 0, notFound: 0, failed: 0, deferred: 1})
    assert.equal(nativeDeletionChildren, 1, 'A repeat sweep started a second physical deletion')
  }
  assert(hasPendingSessionDeletionCleanup(directory), 'Original cleanup disappeared at its timeout')
  await sibling.join() // Closing a separate proxy owner remains independent.
  const joined = owner.join().then(() => joinOutcome = 'fulfilled')
  const closed = outer.close()
  assert.equal(outer.close(), closed)
  closed.then(() => closeOutcome = 'fulfilled', error => { closeOutcome = 'rejected'; closeError = error.message })
  await new Promise(resolve => setTimeout(resolve, 2100))
  before = snapshot()
  assert.equal(joinOutcome, 'pending', 'The GC owner falsely joined unsettled original cleanup')
  assert.equal(closeOutcome, 'rejected', 'Opaque close falsely fulfilled before original GC cleanup joined')
  assert.deepEqual(before, {guardAvailable: false, portsInstalled: true, identityRetained: true, cleanupPending: true})
  release(); releaseAdmission(); replay?.(); await joined
  if (mode === 'admission') assert.deepEqual(await gcWork, {deleted: 1, notFound: 0, failed: 0, deferred: 0})
  for (let count = 0; count < 100; count++) {
    after = snapshot()
    if (after.guardAvailable) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.deepEqual(after, {guardAvailable: true, portsInstalled: false, identityRetained: false, cleanupPending: false})
  if (mode !== 'custom') assert(observedClose)
} finally {
  release(); releaseAdmission(); replay?.()
  await gcWork?.catch(() => undefined)
  await owner.join()
  await outer.close().catch(() => undefined)
  observer?.mockRestore()
  mkdirObserver?.mockRestore()
  console.log('GC_CLOSE_REPORT ' + JSON.stringify({mode, closeOutcome, closeError, joinOutcome, before, after,
    nativeChildCloseSeen: observedClose, nativeDeletionChildren, peerRecovery, modelCalls: 0}))
}
