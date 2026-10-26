import type { ChildProcess } from "node:child_process"

/** Observe at spawn time. Exit or a recycled PID cannot establish pipe closure. */
export function deletionChildClosure(child: ChildProcess): Promise<void> {
  let exited = false
  let spawnFailed = false
  let closed = false
  let stdoutClosed = child.stdout === null
  let stderrClosed = child.stderr === null
  return new Promise<void>(resolve => {
    const complete = (): void => {
      if ((exited || spawnFailed) && closed && stdoutClosed && stderrClosed) resolve()
    }
    child.once("exit", () => { exited = true; complete() })
    child.once("error", () => { spawnFailed = child.pid === undefined; complete() })
    child.once("close", () => { closed = true; complete() })
    child.stdout?.once("close", () => { stdoutClosed = true; complete() })
    child.stderr?.once("close", () => { stderrClosed = true; complete() })
  })
}
