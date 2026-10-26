import { closeProxyBookkeepingWhenSettled, initializeProxyBookkeeping as initializeRuntime } from "./runtime"

/** Public embedding ownership. Native readers, paths and SQL capabilities stay internal. */
export interface ProxyBookkeepingHandle {
  close(): Promise<void>
}

/** Explicit opt-in initialization; JSON remains undefined. Closing a nonfinal owner
 * leaves other owners usable. A final owner retains its guard until all admitted
 * durable work joins, including after a bounded close reports incomplete cleanup. */
export async function initializeProxyBookkeeping(): Promise<ProxyBookkeepingHandle | undefined> {
  const owned = await initializeRuntime()
  if (!owned) return undefined
  let closing: Promise<void> | undefined
  return {
    close() {
      if (closing) return closing
      const joined = closeProxyBookkeepingWhenSettled(owned)
      let timedOut = false
      let timer: ReturnType<typeof setTimeout>
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error("bookkeeping close did not join admitted work before its deadline; ownership retained until cleanup settles"))
        }, 2000)
      })
      // A timeout is a failure, not permission to release an unjoined owner.
      // The original cleanup continues; report a later native failure as well.
      void joined.catch(error => {
        if (timedOut) {
          try { console.error("[bookkeeping] deferred owner close failed:", error) }
          catch { return /* Reporting cannot release uncertain native ownership. */ }
        }
      })
      closing = Promise.race([joined, deadline]).finally(() => clearTimeout(timer))
      return closing
    },
  }
}
