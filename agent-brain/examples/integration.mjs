// Integration template — drop the brain into any "message in → model call → reply out" loop.
// Three touch points. Nothing inside the brain needs to change.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Brain } from '../src/brain.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const brain = new Brain({ file: path.join(here, '..', 'state', 'brain.sqlite') })

/**
 * Touch point 1 — a user message just arrived, before you call the model.
 * Feed `prompt` to the model as a leading system/context block; send the user's
 * own text as usual (don't replace it).
 */
export function beforeReply({ text, session = 'default', atMention = false, now }) {
  const r = brain.onUserMessage({ text, session, atMention, now })
  return {
    prompt: r.prompt,        // persona / tone / memories / behaviour rules
    emotion: r.snapshot,     // { pad, magnitude, levels } — nice to log
    instincts: r.instincts,  // { mustReply, comfortFirst, directAnswer }
    hits: r.hits,
  }
}

/** Touch point 2 — the reply was actually delivered. */
export function afterReply({ text, session = 'default', behavior = 'reply', now }) {
  return brain.onAssistantReply({ text, session, behavior, now })
}

/**
 * Touch point 3 — settle the previous turn once you know (or can infer) how the
 * user reacted. `beforeReply` does this automatically from the next message;
 * call it directly if your transport has read receipts / reactions.
 */
export function settle({ reaction, now } = {}) {
  return brain.applyOutcome({ reaction, now })
}

/** Housekeeping — run on a timer (every few minutes is plenty). */
export function housekeeping(now) {
  brain.tick(now)
  brain.maybeReflect(now)
}
