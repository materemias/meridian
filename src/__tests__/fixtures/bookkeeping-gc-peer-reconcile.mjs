// A separate native SQLite process must honor the original deletion owner.
import {join} from 'node:path'
const [repo, directory] = process.argv.slice(2)
const {initializeSessionBookkeeping} = await import(join(repo, 'src/proxy/session/bookkeeping/database.ts'))
const {reconcile} = await import(join(repo, 'src/proxy/session/bookkeeping/lifecycleReconcileSql.ts'))
const handle = initializeSessionBookkeeping(directory)
try {
  const result = await reconcile([], {storeDir: directory, preparedGraceMs: 0, retiredGraceMs: 0})
  console.log('PEER_RECONCILE ' + JSON.stringify(result))
} finally { handle.close() }
