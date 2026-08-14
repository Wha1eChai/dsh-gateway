import { parentPort, workerData } from 'node:worker_threads'
import { SQLiteAnalyticsEngine, sanitizeWorkerError } from './engine.js'
import type { WorkerData, WorkerRequestMessage, WorkerResponseMessage } from './protocol.js'

if (!parentPort) throw new Error('analytics worker requires a parent port')

const port = parentPort
let engine: SQLiteAnalyticsEngine | undefined

try { engine = new SQLiteAnalyticsEngine(workerData as WorkerData) }
catch (error) {
  port.postMessage({ type: 'fatal', error: sanitizeWorkerError(error) })
  port.close()
}

if (engine) {
  const activeEngine = engine
  let queue = Promise.resolve()
  let closing = false

  port.on('message', (message: WorkerRequestMessage) => {
    if (closing || message?.type !== 'request' || !Number.isSafeInteger(message.id) || message.id < 1) return
    queue = queue.then(async () => {
      try {
        const result = await activeEngine.dispatch(message.operation)
        const response: WorkerResponseMessage = { type: 'response', id: message.id, ok: true, result }
        port.postMessage(response)
        if (message.operation.op === 'close') {
          closing = true
          port.close()
        }
      } catch (error) {
        port.postMessage({ type: 'response', id: message.id, ok: false, error: sanitizeWorkerError(error) })
      }
    })
  })

  port.postMessage({ type: 'ready' })
}
