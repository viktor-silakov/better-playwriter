import { randomUUID } from 'node:crypto'
import type { ElementHandle, Frame, Page } from '@xmorse/playwright-core'
import { getCDPSessionForFrame } from './cdp-session.js'

export interface SnapshotReference {
  frame: Frame
  documentId: string
  backendNodeId: number
}

/** Resolve the original DOM node to a Playwright handle without re-running a selector. */
export async function resolveSnapshotReference({
  page,
  reference,
}: {
  page: Page
  reference: SnapshotReference
}): Promise<ElementHandle> {
  const { frame, documentId, backendNodeId } = reference
  const stale = (cause?: unknown) => new Error('Snapshot ref no longer points to an attached element. Take a fresh snapshot.', { cause })
  if (frame.page() !== page || frame.isDetached()) throw stale()

  const cdp = await getCDPSessionForFrame(frame).catch((cause) => { throw stale(cause) })
  const key = '__pw_ref_' + randomUUID().replaceAll('-', '')
  let documentObjectId: string | undefined
  let bridged = false
  let handle: ElementHandle | undefined
  try {
    const document = await cdp.send('DOM.resolveNode', { backendNodeId: Number(documentId), objectGroup: key })
    documentObjectId = document.object.objectId
    const element = await cdp.send('DOM.resolveNode', { backendNodeId, objectGroup: key })
    if (!documentObjectId || !element.object.objectId) throw stale()

    const argumentsForBridge = [{ objectId: documentObjectId }, { value: key }]
    bridged = true
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: element.object.objectId,
      functionDeclaration: `function(expectedDocument, key) {
        if (this.nodeType !== 1 || !this.isConnected || this.ownerDocument !== expectedDocument) return false;
        Object.defineProperty(expectedDocument, key, { value: this, configurable: true });
        return true;
      }`,
      arguments: argumentsForBridge,
      returnByValue: true,
    })
    if (exceptionDetails || result.value !== true) throw stale()

    // The two clients share Chrome but own different handle groups. Transfer
    // the node through a one-use document property so Playwright owns the
    // returned handle and performs its usual actionability checks.
    const bridgeHandle = await frame.evaluateHandle((key) => document[key], key)
    handle = bridgeHandle.asElement() ?? undefined
    if (!handle) {
      await bridgeHandle.dispose()
      throw stale()
    }
    const verified = await cdp.send('Runtime.callFunctionOn', {
      objectId: element.object.objectId,
      functionDeclaration: `function(expectedDocument, key) {
        const same = this.ownerDocument === expectedDocument && this.isConnected && expectedDocument[key] === this;
        delete expectedDocument[key];
        return same;
      }`,
      arguments: argumentsForBridge,
      returnByValue: true,
    })
    if (verified.exceptionDetails) throw stale()
    bridged = false
    if (verified.result.value !== true) throw stale()
    return handle
  } catch (cause) {
    await handle?.dispose().catch(() => {})
    throw stale(cause)
  } finally {
    if (bridged && documentObjectId) {
      await cdp.send('Runtime.callFunctionOn', {
        objectId: documentObjectId,
        functionDeclaration: 'function(key) { delete this[key]; }',
        arguments: [{ value: key }],
      }).catch(() => {})
    }
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: key }).catch(() => {})
  }
}
