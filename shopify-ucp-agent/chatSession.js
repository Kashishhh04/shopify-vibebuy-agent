import { query } from "@anthropic-ai/claude-agent-sdk";

// A tiny async channel: push() either hands the value straight to a reader
// that's already waiting (next() called first) or, if nobody's waiting yet,
// buffers it until someone asks. Exactly one of "a waiter" or "a buffered
// value" can exist for a given push, so two pushed messages can never race
// each other into the same waiter.
class MessageQueue {
  #buffered = [];
  #waiting = [];

  push(value) {
    const nextWaiter = this.#waiting.shift();
    if (nextWaiter) {
      nextWaiter(value);
    } else {
      this.#buffered.push(value);
    }
  }

  next() {
    if (this.#buffered.length > 0) {
      return Promise.resolve(this.#buffered.shift());
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      yield await this.next();
    }
  }
}

// One ChatSession = one shopper's conversation with the Claude Agent SDK.
// Instead of readline feeding query()'s async generator one line at a time,
// a MessageQueue does - send() pushes onto it, and the generator below pulls
// from it, so many independent ChatSessions can each drive their own query()
// stream concurrently without sharing any mutable state.
const SEARCH_PRODUCTS_TOOL = "mcp__shopify__search_products";
const SUGGEST_FOLLOWUPS_TOOL = "mcp__shopify__suggest_followups";
const UPDATE_CART_TOOL = "mcp__shopify__update_cart";
const VIEW_CART_TOOL = "mcp__shopify__view_cart";
const GO_TO_CHECKOUT_TOOL = "mcp__shopify__go_to_checkout";
const LIST_DISCOUNT_CODES_TOOL = "mcp__shopify__list_discount_codes";
const FLAG_OFF_TOPIC_TOOL = "mcp__shopify__flag_off_topic";
const FLAG_UNCLEAR_TOOL = "mcp__shopify__flag_unclear";

export class ChatSession {
  #queue = new MessageQueue();
  #pending = null;
  #chain = Promise.resolve();
  #stream;
  // tool_use id -> tool name, so a later tool_result can be matched back to
  // the call that produced it. Reset at the start of every turn since ids
  // are only ever referenced within the turn that created them.
  #toolNameByUseId = new Map();
  // Product results from any search_products call made during the turn
  // currently in flight, handed back to the caller alongside the reply text.
  #turnProducts = [];
  // Follow-up questions from any suggest_followups call made during the
  // turn currently in flight, handed back the same way.
  #turnSuggestions = [];
  // The last view_cart result from the turn currently in flight (null until
  // called), handed back the same way.
  #turnCart = null;
  // The last update_cart result from the turn currently in flight (null
  // until called) - lets the caller build its own deterministic add/remove/
  // quantity-change confirmation from what actually happened, instead of
  // trusting the model's own reply text to mention it (found unreliable in
  // testing for phrasing that doesn't literally start with "add"/"remove").
  #turnCartUpdate = null;
  // The last go_to_checkout result from the turn currently in flight (null
  // until called) - kept separate from #turnCart so the caller can tell
  // "just show my cart" and "take me to checkout" apart and only
  // auto-navigate for the latter.
  #turnCheckout = null;
  // The last list_discount_codes result from the turn currently in flight
  // (null until called), handed back the same way - lets a caller build its
  // own deterministic reply from the real codes instead of trusting the
  // model's prose to always mention one.
  #turnDiscounts = null;
  // Whether flag_off_topic was called during the turn currently in flight -
  // lets the caller count off-topic turns without guessing relevance from
  // the reply text itself.
  #turnOffTopic = false;
  // Whether flag_unclear was called during the turn currently in flight -
  // same idea as #turnOffTopic, but for messages the model genuinely
  // couldn't parse into any intent at all (as opposed to a clear message
  // that's simply unrelated to the store).
  #turnUnclear = false;

  constructor(options = {}) {
    this.#stream = query({
      prompt: this.#inputs(),
      options,
    });

    this.#consume(this.#stream).catch((err) => {
      // The stream itself died (not a single turn) - fail whichever send()
      // is currently waiting so its caller doesn't hang forever.
      this.#pending?.reject(err);
      this.#pending = null;
    });
  }

  async *#inputs() {
    for await (const text of this.#queue) {
      yield {
        type: "user",
        message: { role: "user", content: text },
      };
    }
  }

  async #consume(stream) {
    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message.content ?? []) {
          if (block.type === "tool_use") {
            this.#toolNameByUseId.set(block.id, block.name);
          }
        }
        continue;
      }

      if (message.type === "user") {
        for (const block of message.message.content ?? []) {
          if (block.type !== "tool_result") continue;
          const toolName = this.#toolNameByUseId.get(block.tool_use_id);
          if (toolName === SEARCH_PRODUCTS_TOOL) {
            this.#turnProducts.push(...(this.#parseToolResult(block.content)?.products ?? []));
          } else if (toolName === SUGGEST_FOLLOWUPS_TOOL) {
            this.#turnSuggestions.push(...(this.#parseToolResult(block.content)?.questions ?? []));
          } else if (toolName === VIEW_CART_TOOL) {
            this.#turnCart = this.#parseToolResult(block.content);
          } else if (toolName === UPDATE_CART_TOOL) {
            this.#turnCartUpdate = this.#parseToolResult(block.content);
          } else if (toolName === GO_TO_CHECKOUT_TOOL) {
            this.#turnCheckout = this.#parseToolResult(block.content);
          } else if (toolName === LIST_DISCOUNT_CODES_TOOL) {
            this.#turnDiscounts = this.#parseToolResult(block.content);
          } else if (toolName === FLAG_OFF_TOPIC_TOOL) {
            this.#turnOffTopic = true;
          } else if (toolName === FLAG_UNCLEAR_TOOL) {
            this.#turnUnclear = true;
          }
        }
        continue;
      }

      if (message.type !== "result") continue;

      const pending = this.#pending;
      this.#pending = null;
      if (!pending) continue;

      if (message.subtype === "success") {
        pending.resolve({
          reply: message.result,
          products: this.#turnProducts,
          suggestions: this.#turnSuggestions,
          cart: this.#turnCart,
          cartUpdate: this.#turnCartUpdate,
          checkout: this.#turnCheckout,
          discounts: this.#turnDiscounts,
          offTopic: this.#turnOffTopic,
          unclear: this.#turnUnclear,
        });
      } else {
        pending.reject(new Error(`Turn ended without a reply: ${message.subtype}`));
      }
    }
  }

  // A tool_result's `content` is either a plain string or an array of
  // content blocks; our own tools always reply with a single text block
  // holding the JSON their tool function produced.
  #parseToolResult(content) {
    const text = Array.isArray(content)
      ? content.find((block) => block.type === "text")?.text
      : content;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Pushes `text` and resolves with the assistant's full reply for that turn.
  // Chained onto the previous send()'s promise so two messages from the same
  // shopper are always processed one at a time, never in parallel.
  send(text) {
    const turn = this.#chain.then(() => this.#sendTurn(text));
    // Keep the chain itself always-fulfilled so a rejected turn doesn't
    // permanently wedge every send() queued after it; the rejection is still
    // delivered to whoever called this particular send().
    this.#chain = turn.catch(() => {});
    return turn;
  }

  #sendTurn(text) {
    this.#turnProducts = [];
    this.#turnSuggestions = [];
    this.#turnCart = null;
    this.#turnCartUpdate = null;
    this.#turnCheckout = null;
    this.#turnDiscounts = null;
    this.#turnOffTopic = false;
    this.#turnUnclear = false;
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#queue.push(text);
    });
  }

  // Stops the underlying query() stream so an idle session doesn't leave a
  // process/session running forever. Rejects any turn that was in flight.
  async close() {
    this.#pending?.reject(new Error("Session closed"));
    this.#pending = null;
    await this.#stream.return();
  }
}
