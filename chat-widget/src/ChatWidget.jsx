import { useEffect, useRef, useState } from 'react'
import './ChatWidget.css'

// Empty (relative paths, e.g. "/api/chat") for local dev, where Vite's own
// proxy forwards those to the backend on localhost:3000 - see vite.config.js.
// Once this widget is embedded on an actual storefront page, its fetches run
// in that page's origin, not the backend's, so they need the backend's real
// deployed URL instead; set at build time via VITE_API_BASE_URL (e.g.
// "https://your-app.onrender.com") so this same source works in both places.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

const SESSION_ID_KEY = 'shopper-chat-session-id'
// localStorage (not sessionStorage) - this is a device/browser-level
// preference like a volume toggle, not part of any one chat session, so it
// should stay off (or on) across tabs and after a new chat/session starts.
const SOUND_MUTED_KEY = 'shopper-chat-sound-muted'

function loadSoundMuted() {
  try {
    return localStorage.getItem(SOUND_MUTED_KEY) === 'true'
  } catch {
    return false
  }
}
// The visible conversation used to live only in React state, with nothing
// but the sessionId persisted - so a background tab reload (very common
// when switching apps, especially on mobile) wiped the messages shown on
// screen back to just the greeting, while the backend's ChatSession (found
// again via that same persisted sessionId) kept going right where it left
// off. The mismatch looked like "my conversation ended and a new one
// started" - a fresh "hi" would land mid an old bulk-order collection, off
// topic count, etc. Persisting the conversation itself alongside the
// sessionId keeps what's on screen in sync with what the backend actually
// remembers.
const CHAT_STATE_KEY = 'shopper-chat-state'

function loadPersistedChatState() {
  try {
    const raw = sessionStorage.getItem(CHAT_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null
    return {
      messages: parsed.messages.map((message) => ({
        ...message,
        timestamp: message.timestamp ? new Date(message.timestamp) : undefined,
      })),
      sessionEnded: Boolean(parsed.sessionEnded),
      cartHasItems: Boolean(parsed.cartHasItems),
      // Older persisted sessions (saved before this field existed) never set
      // it, which must default to false, not true - those shoppers already
      // have a real conversation going and shouldn't suddenly get locked out
      // of it because of a field their saved state doesn't have.
      awaitingEmail: parsed.awaitingEmail === undefined ? false : Boolean(parsed.awaitingEmail),
    }
  } catch {
    return null
  }
}
// Mirrors the backend's own go_to_checkout trigger phrases closely enough
// to guess, client-side, whether a message is about to send the shopper to
// checkout - used only to decide whether to pre-open a blank tab (see
// sendMessage) before the async request starts.
const CHECKOUT_INTENT_RE = /check\s*out|ready to pay|proceed to pay/i
const SUPPORT_EMAIL = 'kashish.tawar@vgroup.net'
// TODO: add the support WhatsApp number (country code + number, no "+" or
// spaces, e.g. "919876543210") once it's available.
const SUPPORT_WHATSAPP_NUMBER = ''

// Synthesized instead of shipping an audio file - a couple of short sine
// tones through the Web Audio API are enough for a subtle notification
// blip, without adding an asset or a network request for something this
// small. One shared AudioContext is reused (created lazily, on the first
// sound a shopper's own action - sending a message - triggers, which is
// also the user gesture browsers require before audio is allowed to play).
let notificationAudioCtx = null

function getNotificationAudioCtx() {
  const AudioContextClass = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)
  if (!AudioContextClass) return null
  if (!notificationAudioCtx) notificationAudioCtx = new AudioContextClass()
  if (notificationAudioCtx.state === 'suspended') notificationAudioCtx.resume().catch(() => {})
  return notificationAudioCtx
}

function playNotificationTone(frequency, startDelay, duration, peakVolume) {
  try {
    const ctx = getNotificationAudioCtx()
    if (!ctx) return
    const startAt = ctx.currentTime + startDelay
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    gain.gain.setValueAtTime(0, startAt)
    gain.gain.linearRampToValueAtTime(peakVolume, startAt + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration)
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(startAt)
    oscillator.stop(startAt + duration + 0.02)
  } catch {
    // Autoplay/audio restrictions vary by browser - a missed notification
    // sound is never worth surfacing as an error to the shopper.
  }
}

// A muted, low-pitched tick when the bot starts "typing" (the dots appear) -
// pitched and timed to read as a quiet UI cue, not a phone-style alert.
function playTypingSound() {
  playNotificationTone(420, 0, 0.05, 0.03)
}

// A soft two-note resolve, pitched downward, once its reply is actually on
// screen - the descending interval reads as a quiet "done" cue rather than
// the bright ascending ding of a mobile notification.
function playReplySound() {
  playNotificationTone(520, 0, 0.06, 0.035)
  playNotificationTone(390, 0.05, 0.08, 0.03)
}

// Chrome/Edge/Safari ship this under the vendor-prefixed name; Firefox has
// no implementation at all, so the mic button hides itself when neither exists.
const SpeechRecognitionAPI =
  typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined

// The browser already runs on the shopper's own device, so `new Date()` is
// already their local clock - what varies is the *convention* (mm/dd vs
// dd/mm, 12- vs 24-hour, month names in their own language). Passing
// navigator.language instead of a pinned locale lets toLocale*String render
// each date/time the way that shopper's own device/browser is set to, i.e.
// the convention of whatever country they're actually chatting from, rather
// than forcing everyone into one fixed format.
function customerLocale() {
  return typeof navigator !== 'undefined' && navigator.language ? navigator.language : undefined
}

// The shopper's IANA zone (e.g. "Asia/Kolkata") - sent to the backend with
// every chat message so a bulk-order lead can be recorded with the zone the
// shopper was actually in, not just a UTC capture timestamp that says
// nothing about when's a reasonable time to follow up with them.
function customerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

function formatCustomerDate(date) {
  return date.toLocaleDateString(customerLocale(), { month: '2-digit', day: '2-digit', year: 'numeric' })
}

// e.g. "2:30:45 PM GMT+5:30" - timeZoneName appends the shopper's own zone
// right onto each timestamp, so it's unambiguous per line without needing a
// separate explanatory sentence elsewhere in the transcript.
function formatCustomerTime(date) {
  return date.toLocaleTimeString(customerLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })
}

// e.g. "Wednesday, September 16" (in the shopper's own language/locale) -
// weekday name, month name, day number, for the widget's own date divider,
// which reads better as a sentence than the numeric date used for the
// downloadable transcript's filename/lines.
function formatCustomerLongDate(date) {
  return date.toLocaleDateString(customerLocale(), { weekday: 'long', month: 'long', day: 'numeric' })
}

// sessionStorage (not localStorage) so each browser tab gets its own
// session id - localStorage is shared across every tab of the same origin,
// which meant a "new" tab silently reused the same shopper session and cart.
function getOrCreateSessionId() {
  let sessionId = sessionStorage.getItem(SESSION_ID_KEY)
  if (!sessionId) {
    sessionId = crypto.randomUUID()
    sessionStorage.setItem(SESSION_ID_KEY, sessionId)
  }
  return sessionId
}

// Matched purely on the frontend against the backend's known fixed replies
// (server.js's bulkOrderSentence/bulkCollectingAckTurn/bulkNeedEmailTurn) -
// no backend changes. Covers every stage of the bulk flow, not just the
// opening ask, so a shopper who mistypes their email (or wants to add more)
// always gets a form back instead of being dropped into plain-text-only
// once the conversation moves past the first reply.
const BULK_NEED_EMAIL_RE = /fill in your email in the form below/i
const BULK_FULL_FORM_RE = /product\(s\) and quantity you need/i

function bulkFormModeFor(reply) {
  if (BULK_NEED_EMAIL_RE.test(reply ?? '')) return 'email'
  if (BULK_FULL_FORM_RE.test(reply ?? '')) return 'full'
  return null
}

// Matched against the backend's fixed nameCaptureAckTurn sentence (server.js)
// - the name it guessed from the shopper's email (e.g. "priya.sharma99@..."
// -> "Priya") can be wrong, so this pulls it back out of that exact reply to
// offer a small "change it" box right underneath.
const GREETING_NAME_ACK_RE = /^Thanks, (.+)! What can I help you find today\?$/

function greetNameFrom(reply) {
  return reply?.match(GREETING_NAME_ACK_RE)?.[1] ?? null
}

// Shopify's Storefront Cart API only ever hands back checkoutUrl for a cart,
// which lands the shopper straight in checkout - not on a browsable "here's
// what's in your cart" page. The backend now derives a real cart-page URL
// (cartUrl, a Shopify cart permalink) alongside it, so a plain "what's in my
// cart?" lookup (data.cart) can link to the actual cart page, while an
// explicit checkout ask (data.checkout) still links straight to checkout -
// two genuinely different destinations, never conflated.
function assistantMessageFrom(data) {
  const checkoutInfo = data.checkout?.itemCount > 0 ? data.checkout : null
  const cartInfo = data.cart?.itemCount > 0 ? data.cart : null
  return {
    role: 'assistant',
    content: data.reply,
    products: data.products,
    suggestions: data.suggestions,
    checkoutUrl: checkoutInfo?.checkoutUrl,
    cartUrl: cartInfo?.cartUrl,
    bulkFormMode: bulkFormModeFor(data.reply),
    greetName: greetNameFrom(data.reply),
    // Rides along on every reply (not just cart-related ones) so a shopper
    // who's just earned a free item sees the picker on their very next
    // message, whatever it's about - see server.js's /api/chat handler.
    freeGift: data.freeGift?.remainingSlots > 0 ? data.freeGift : null,
    // Set on the deterministic "remove an item" reply (see server.js's
    // REMOVE_ITEM_RE branch) - tells the product cards below to show a
    // "Remove" button instead of the usual "Add to cart" one.
    removalMode: Boolean(data.removalMode),
    timestamp: new Date(),
  }
}

// Basic shape check only (local@domain.tld) - not exhaustive RFC 5322, just
// enough to catch the things shoppers actually get wrong: leaving off the
// "@domain" part, typing a half-finished address, or mistyping the
// extension (e.g. "gmai.comm" instead of "gmail.com") - real TLDs are 2-3
// letters, so anything longer or non-alphabetic after the last dot is
// rejected rather than accepted as some address on an unknown domain.
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,3}$/
const MIN_EMAIL_LOCAL_PART_LENGTH = 6
const MIN_PRODUCT_INFO_LENGTH = 10

function BulkOrderForm({ mode, onSubmit }) {
  const [productInfo, setProductInfo] = useState('')
  const [email, setEmail] = useState('')
  const [productError, setProductError] = useState('')
  const [emailError, setEmailError] = useState('')

  const handleSubmit = (event) => {
    event.preventDefault()
    const trimmedEmail = email.trim()

    if (mode !== 'email') {
      const trimmedProduct = productInfo.trim()
      if (trimmedProduct.length < MIN_PRODUCT_INFO_LENGTH) {
        setProductError(
          `Please describe your bulk order in more detail (at least ${MIN_PRODUCT_INFO_LENGTH} characters).`
        )
        return
      }
      setProductError('')
    }

    if (!trimmedEmail) {
      setEmailError('Please enter a complete email.')
      return
    }
    if (!EMAIL_SHAPE_RE.test(trimmedEmail)) {
      setEmailError('Please enter a valid email.')
      return
    }
    const [localPart] = trimmedEmail.split('@')
    if (localPart.length < MIN_EMAIL_LOCAL_PART_LENGTH) {
      setEmailError(`Please enter a valid email - the part before @ needs at least ${MIN_EMAIL_LOCAL_PART_LENGTH} characters.`)
      return
    }
    setEmailError('')

    if (mode === 'email') {
      onSubmit(null, trimmedEmail)
      return
    }

    onSubmit(productInfo.trim(), trimmedEmail)
  }

  return (
    <form className="bulk-form" onSubmit={handleSubmit}>
      <div className="bulk-form__title">{mode === 'email' ? 'Your Email' : 'Bulk Order Details'}</div>
      {mode !== 'email' && (
        <>
          <textarea
            className={['bulk-form__field', productError && 'bulk-form__field--error'].filter(Boolean).join(' ')}
            placeholder="Which product(s) would you like in bulk? Please include details like quantity."
            value={productInfo}
            onChange={(event) => {
              setProductInfo(event.target.value)
              if (productError) setProductError('')
            }}
            rows={3}
          />
          {productError && <div className="bulk-form__error">{productError}</div>}
        </>
      )}
      <input
        type="email"
        className={['bulk-form__field', emailError && 'bulk-form__field--error'].filter(Boolean).join(' ')}
        placeholder="Email address"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value)
          if (emailError) setEmailError('')
        }}
      />
      {emailError && <div className="bulk-form__error">{emailError}</div>}
      <button type="submit" className="bulk-form__send">
        Send
      </button>
    </form>
  )
}

// Shown below the very first greeting so a shopper can fill in their email
// right away instead of typing it as a chat message. Reuses the bulk-form
// styling for the same compact look, but submits the bare email on its own
// (not folded into a sentence like "my email is x@y.com") - the backend
// only sends its deterministic "Thanks, {name}!" greeting when the message
// is nothing but the email itself (see isBareEmail in server.js).
function EmailCaptureForm({ onSubmit }) {
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  // A ref, not state - a fast double-click or double-Enter fires two submit
  // events in the same tick, before a state update would have re-rendered
  // to disable anything, so a state-based guard can't reliably stop the
  // second one. A ref updates immediately, so it does. Without this, the
  // second submit could reach the backend a moment after the first already
  // recorded the shopper's name, land after that name-capture check, and
  // fall through to a generic reply instead of the "Thanks, X!" greeting.
  const submittedRef = useRef(false)

  const handleSubmit = (event) => {
    event.preventDefault()
    if (submittedRef.current) return
    const trimmedEmail = email.trim()

    if (!trimmedEmail) {
      setEmailError('Please enter a complete email.')
      return
    }
    if (!EMAIL_SHAPE_RE.test(trimmedEmail)) {
      setEmailError('Please enter a valid email.')
      return
    }
    const [localPart] = trimmedEmail.split('@')
    if (localPart.length < MIN_EMAIL_LOCAL_PART_LENGTH) {
      setEmailError(
        `Please enter a valid email - the part before @ needs at least ${MIN_EMAIL_LOCAL_PART_LENGTH} characters.`
      )
      return
    }
    setEmailError('')
    submittedRef.current = true
    onSubmit(trimmedEmail)
  }

  return (
    <form className="bulk-form" onSubmit={handleSubmit}>
      <div className="bulk-form__title">Your Email</div>
      <input
        type="email"
        className={['bulk-form__field', emailError && 'bulk-form__field--error'].filter(Boolean).join(' ')}
        placeholder="Email address"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value)
          if (emailError) setEmailError('')
        }}
      />
      {emailError && <div className="bulk-form__error">{emailError}</div>}
      <button type="submit" className="bulk-form__send">
        Send
      </button>
    </form>
  )
}

const MAX_PREFERRED_NAME_LENGTH = 40

// Shown right under the "Thanks, {name}!" greeting ack - the name is only a
// guess from the local part of the shopper's email, so this lets them
// correct it on the spot instead of being stuck with a wrong guess for the
// rest of the conversation.
function ChangeNameForm({ currentName, onSubmit }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (event) => {
    event.preventDefault()
    const trimmed = name.trim()

    if (!trimmed) {
      setError('Please enter a name.')
      return
    }
    if (trimmed.length > MAX_PREFERRED_NAME_LENGTH) {
      setError('Please enter a shorter name.')
      return
    }
    setError('')
    onSubmit(trimmed)
  }

  return (
    <form className="bulk-form" onSubmit={handleSubmit}>
      <div className="bulk-form__title">Not {currentName}? Change it</div>
      <input
        type="text"
        className={['bulk-form__field', error && 'bulk-form__field--error'].filter(Boolean).join(' ')}
        placeholder="Preferred name"
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          if (error) setError('')
        }}
      />
      {error && <div className="bulk-form__error">{error}</div>}
      <button type="submit" className="bulk-form__send">
        Save
      </button>
    </form>
  )
}

// Generic chat-bubble/assistant mark reused for the header logo, the
// message avatar, and the launcher button - not a copy of any third-party
// product's logo, just a consistent glyph for our own teal brand color.
function AgentIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M4 5.75A2.75 2.75 0 016.75 3h10.5A2.75 2.75 0 0120 5.75v6.5A2.75 2.75 0 0117.25 15H10l-4.2 3.6a.5.5 0 01-.8-.38V15h-.25A2.75 2.75 0 012 12.25v-6.5z"
        fill="currentColor"
      />
      <circle cx="8" cy="9.25" r="1" fill="#fff" />
      <circle cx="12" cy="9.25" r="1" fill="#fff" />
      <circle cx="16" cy="9.25" r="1" fill="#fff" />
    </svg>
  )
}

function formatPrice(product) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: product.currency,
  }).format(product.price)
}

// A cart-line item carries its own `quantity` (search_products results
// never do) - shown as a quantity badge, alongside a "Remove" button when
// onRemove is passed (see server.js's REMOVE_ITEM_RE reply). The regular
// "Add to cart" button wouldn't make sense for something already in the
// cart, so the two are mutually exclusive branches, not just conditional
// buttons within one. isFreeGift marks a still-to-be-claimed Buy-X-Get-Y
// option (see FreeGiftPicker) - distinct from a cart line's own `isFree`,
// which means it's already in the cart at $0.
function ProductCard({ product, status, onAdd, onRemove, isFreeGift = false }) {
  const isCartLine = product.quantity != null
  return (
    <div className="product-card">
      {product.imageUrl && (
        <img className="product-card__image" src={product.imageUrl} alt={product.imageAlt} />
      )}
      <div className="product-card__title">{product.title}</div>
      {product.isFree ? (
        <div className="product-card__price product-card__price--free">FREE</div>
      ) : (
        <div className="product-card__price">{formatPrice(product)}</div>
      )}
      {isCartLine ? (
        <>
          <div className="product-card__qty">Qty: {product.quantity}</div>
          {onRemove && (
            <button
              type="button"
              className="product-card__remove"
              disabled={status === 'removing' || status === 'removed'}
              onClick={() => onRemove(product)}
            >
              {status === 'removing' ? 'Removing…' : status === 'removed' ? 'Removed' : 'Remove'}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="product-card__stock">
            {product.availableForSale ? 'In stock' : 'Out of stock'}
          </div>
          <button
            type="button"
            className={['product-card__add', isFreeGift && 'product-card__add--free'].filter(Boolean).join(' ')}
            disabled={!product.availableForSale || status === 'adding' || status === 'added'}
            onClick={() => onAdd(product)}
          >
            {status === 'adding'
              ? 'Adding…'
              : status === 'added'
                ? 'Added ✓'
                : isFreeGift
                  ? 'Get it free'
                  : 'Add to cart'}
          </button>
        </>
      )}
    </div>
  )
}

// Cart-line products only (search_products results never carry `isFree`, so
// freeItems is always empty for those and everything renders as one plain
// grid, same as before). Split into two grids rather than one mixed one so a
// free-gift line reads as its own distinct thing, not just another priced
// item that happens to say $0.00. onRemove is only passed for a
// removal-mode message (see server.js's REMOVE_ITEM_RE reply) - every other
// cart display (an "Added to cart" confirmation, a plain "view cart" lookup)
// stays remove-button-free.
function CartItemGrids({ products, cartStatusByVariant, onAdd, onRemove }) {
  if (!products?.length) return null
  const isCartView = products[0].quantity != null
  const paidItems = isCartView ? products.filter((product) => !product.isFree) : products
  const freeItems = isCartView ? products.filter((product) => product.isFree) : []

  return (
    <>
      {isCartView && paidItems.length > 0 && (
        <div className="chat-widget__products-label">Items in your cart</div>
      )}
      {paidItems.length > 0 && (
        <div className="product-grid">
          {paidItems.map((product) => (
            <ProductCard
              key={product.variantId}
              product={product}
              status={cartStatusByVariant[product.variantId]}
              onAdd={onAdd}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
      {freeItems.length > 0 && (
        <>
          <div className="chat-widget__products-label chat-widget__products-label--free">🎁 Free items</div>
          <div className="product-grid">
            {freeItems.map((product) => (
              <ProductCard
                key={product.variantId}
                product={product}
                status={cartStatusByVariant[product.variantId]}
                onAdd={onAdd}
                onRemove={onRemove}
              />
            ))}
          </div>
        </>
      )}
    </>
  )
}

// The Buy-X-Get-Y picker - rendered whenever a message carries an unclaimed
// freeGift (see assistantMessageFrom/handleAddToCart/handleAddFreeGift),
// which is every reply while the shopper still has a free pick open, not
// just the one that unlocked it. Uses its own status map (statusByVariant),
// separate from the regular add-to-cart one - a free-gift option can be the
// exact same variant already added elsewhere at full price, and shouldn't
// show pre-disabled here just because that unrelated button was clicked.
function FreeGiftPicker({ freeGift, statusByVariant, onAdd }) {
  if (!freeGift?.options?.length) return null
  const noun = freeGift.remainingSlots > 1 ? 'items' : 'item'

  return (
    <>
      <div className="chat-widget__products-label chat-widget__products-label--free">
        🎁 You've earned {freeGift.remainingSlots} free {noun} - pick one
      </div>
      <div className="product-grid">
        {freeGift.options.map((product) => (
          <ProductCard
            key={product.variantId}
            product={product}
            status={statusByVariant[product.variantId]}
            onAdd={onAdd}
            isFreeGift
          />
        ))}
      </div>
    </>
  )
}

function createGreeting() {
  return {
    role: 'assistant',
    content: "Hey! I'm VibeBuy, your shopping buddy. What are you in the mood to shop for today?",
    // Renders the small email-only form below this bubble (see
    // EmailCaptureForm) instead of asking for it in the text itself -
    // dropped once messages.length - 1 no longer points at this message,
    // i.e. the moment the shopper sends anything at all.
    showEmailCapture: true,
    timestamp: new Date(),
  }
}

function ChatWidget() {
  const [sessionId, setSessionId] = useState(getOrCreateSessionId)
  const [isOpen, setIsOpen] = useState(true)
  // Computed once when the session/tab starts, not live-ticking - it's a
  // date divider marking when this chat began, like a messaging app's
  // "Today"/date separator, not a clock.
  const [sessionDate] = useState(() => formatCustomerLongDate(new Date()))
  // Restored from sessionStorage when this tab already had a conversation
  // going (see CHAT_STATE_KEY above) - falls back to a fresh greeting only
  // when there's genuinely nothing to restore.
  const [messages, setMessages] = useState(() => loadPersistedChatState()?.messages ?? [createGreeting()])
  const [inputValue, setInputValue] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [sessionEnded, setSessionEnded] = useState(() => loadPersistedChatState()?.sessionEnded ?? false)
  // Blocks the normal chat input until the greeting's email form is filled
  // in - true by default for a genuinely fresh tab (nothing persisted yet),
  // see loadPersistedChatState for why a restored older session defaults to
  // false instead.
  const [awaitingEmail, setAwaitingEmail] = useState(() => loadPersistedChatState()?.awaitingEmail ?? true)
  const [cartStatusByVariant, setCartStatusByVariant] = useState({})
  // Separate from cartStatusByVariant - a free-gift option can be the exact
  // same variant a shopper already added at full price elsewhere, and it
  // shouldn't show as pre-disabled ("Added ✓") in the free-item picker just
  // because that other, unrelated button was already clicked.
  const [freeGiftStatusByVariant, setFreeGiftStatusByVariant] = useState({})
  // Tracks whether the cart is known to have anything in it, from whatever
  // the backend last reported - used only to decide whether a "checkout"
  // ask is worth pre-opening a tab for (see sendMessage). Starts false so a
  // fresh session's first "checkout" doesn't pre-open one for a cart that's
  // almost certainly still empty.
  const [cartHasItems, setCartHasItems] = useState(() => loadPersistedChatState()?.cartHasItems ?? false)
  const [isListening, setIsListening] = useState(false)
  const [isSoundMuted, setIsSoundMuted] = useState(loadSoundMuted)
  // null until first dragged - the widget starts pinned via CSS bottom/right,
  // and only switches to explicit left/top coordinates once the shopper
  // actually drags it, so it doesn't jump on first render.
  const [position, setPosition] = useState(null)
  const [isDragging, setIsDragging] = useState(false)
  // The "Not X? Change it" box is only ever meant to appear once, right after
  // the very first name-capture ack - GREETING_NAME_ACK_RE matches on plain
  // text, so if a later reply ever happens to repeat that same sentence
  // (e.g. the shopper says "no, keep the same name" and the model echoes the
  // greeting back), it would otherwise pop the correction box up again for
  // no reason. Seeded from any already-persisted messages so a reloaded tab
  // doesn't get a second chance at showing it either.
  const nameCorrectionOfferedRef = useRef(messages.some((message) => message.greetName))
  // Mirrors isSending, but as a ref - a fast double-click/double-Enter fires
  // two submits in the same tick, before the isSending state update (and the
  // disabled attribute it drives) has actually re-rendered, so that check
  // alone can't reliably stop the second one. This is most visible right
  // after giving an email: the first request correctly greets by name and
  // records it server-side, and a near-simultaneous second one lands a
  // moment later, finds the name already recorded, and falls through to an
  // unrelated reply instead of repeating the greeting.
  const isSendingRef = useRef(false)
  const messagesEndRef = useRef(null)
  const shineRef = useRef(null)
  const widgetRef = useRef(null)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const recognitionRef = useRef(null)
  const inputRef = useRef(null)

  // Stop any in-flight recognition if the widget unmounts (e.g. closed)
  // mid-recording, so it doesn't keep the mic open in the background.
  useEffect(() => {
    return () => recognitionRef.current?.stop()
  }, [])

  // Keeps sessionStorage in sync with what's actually on screen, so a
  // background reload (see CHAT_STATE_KEY above) restores the same
  // conversation instead of silently dropping back to the greeting while
  // the backend session underneath keeps remembering everything.
  useEffect(() => {
    try {
      sessionStorage.setItem(
        CHAT_STATE_KEY,
        JSON.stringify({ messages, sessionEnded, cartHasItems, awaitingEmail })
      )
    } catch {
      // Storage can be full or unavailable (private browsing, etc.) - the
      // conversation still works for this tab's lifetime either way, it
      // just won't survive a reload.
    }
  }, [messages, sessionEnded, cartHasItems, awaitingEmail])

  // The input used to disable itself while a reply was in flight, which
  // drops browser focus - the shopper had to click back into it before
  // every single message. Kept enabled the whole time now (see the input
  // below), and refocused here the moment a reply lands, so the cursor is
  // always ready for the next message without an extra click. Also
  // refocused on isOpen so reopening from the launcher bubble (isSending
  // itself doesn't change on reopen) lands the cursor in the input too.
  useEffect(() => {
    if (isOpen && !isSending) inputRef.current?.focus()
  }, [isSending, isOpen])

  // Building this sessionId's backend ChatSession is the slow part of a
  // first message (9-11s, versus under 2s for every turn after) - kicked
  // off here, the moment the widget mounts (or a new chat starts), so that
  // cost happens in the background while the shopper is still reading the
  // greeting instead of blocking whatever they type first. Best-effort:
  // nothing meaningful to do if it fails, the first real message just pays
  // the cold-start cost itself like before.
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/warmup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }, [sessionId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages, isSending])

  // Dragging is scoped to the handle bar only (via its own onMouseDown) so
  // it never steals mousedown from messages, buttons, or the input field.
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (event) => {
      const rect = widgetRef.current.getBoundingClientRect()
      const maxX = window.innerWidth - rect.width
      const maxY = window.innerHeight - rect.height
      const x = Math.min(Math.max(event.clientX - dragOffsetRef.current.x, 0), Math.max(maxX, 0))
      const y = Math.min(Math.max(event.clientY - dragOffsetRef.current.y, 0), Math.max(maxY, 0))
      setPosition({ x, y })
    }

    const handleMouseUp = () => setIsDragging(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  const handleDragStart = (event) => {
    event.preventDefault()
    const rect = widgetRef.current.getBoundingClientRect()
    dragOffsetRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    setIsDragging(true)
  }

  // Written straight to the DOM (not React state) so the gradient tracks the
  // cursor at full mousemove frequency without a re-render on every pixel.
  const handleShineMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    if (shineRef.current) {
      shineRef.current.style.background =
        `radial-gradient(circle 180px at ${x}px ${y}px, rgba(255,255,255,0.4), transparent 70%)`
    }
  }

  const handleShineLeave = () => {
    if (shineRef.current) shineRef.current.style.background = 'transparent'
  }

  const sendMessage = async (trimmed) => {
    if (!trimmed || isSending || sessionEnded || isSendingRef.current) return
    isSendingRef.current = true

    // Opened synchronously, still inside the click/submit handler's user
    // gesture, so the browser doesn't treat it as a popup - by the time the
    // checkout URL is actually known (after the awaited fetch below), it's
    // too late to open a new tab without it getting blocked. Gated on
    // cartHasItems too, so asking to check out an empty cart never even
    // flashes a blank tab open before immediately closing it again.
    const checkoutWindow =
      CHECKOUT_INTENT_RE.test(trimmed) && cartHasItems ? window.open('', '_blank') : null

    setMessages((prev) => [...prev, { role: 'user', content: trimmed, timestamp: new Date() }])
    setInputValue('')
    setIsSending(true)
    if (!isSoundMuted) playTypingSound()

    try {
      const res = await fetch(`${API_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: trimmed, timeZone: customerTimeZone() }),
      })

      if (!res.ok) throw new Error(`Request failed with status ${res.status}`)

      const data = await res.json()
      const rawMessage = assistantMessageFrom(data)
      const assistantMessage =
        rawMessage.greetName && nameCorrectionOfferedRef.current ? { ...rawMessage, greetName: null } : rawMessage
      if (assistantMessage.greetName) nameCorrectionOfferedRef.current = true
      setMessages((prev) => [...prev, assistantMessage])
      if (!isSoundMuted) playReplySound()
      if (data.sessionEnded) setSessionEnded(true)

      const itemCount = data.checkout?.itemCount ?? data.cart?.itemCount
      if (itemCount !== undefined) setCartHasItems(itemCount > 0)

      // Only go_to_checkout (an explicit "checkout" ask) auto-navigates -
      // view_cart ("what's in my cart?") only ever shows the link above,
      // never redirects on its own. Opens in the pre-opened tab (see above)
      // so the shopper's conversation here stays put; if nothing was
      // pre-opened (a message go_to_checkout fired on but that this
      // widget's own heuristic didn't recognize as a checkout ask), falls
      // back to a same-tab redirect rather than silently doing nothing.
      if (data.checkout?.itemCount > 0 && data.checkout.checkoutUrl) {
        if (checkoutWindow) {
          checkoutWindow.location.href = data.checkout.checkoutUrl
        } else {
          window.location.href = data.checkout.checkoutUrl
        }
      } else {
        checkoutWindow?.close()
      }
    } catch {
      checkoutWindow?.close()
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          isError: true,
          content: "Sorry, that message didn't go through. Please try again.",
          timestamp: new Date(),
        },
      ])
    } finally {
      setIsSending(false)
      isSendingRef.current = false
    }
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    sendMessage(inputValue.trim())
  }

  const handleSuggestionClick = (question) => {
    sendMessage(question)
  }

  // Starts a fresh conversation without closing the widget - a new session
  // id (so the backend doesn't carry over the old cart/lead state) plus a
  // reset of every piece of state tied to the old session. Blocked once the
  // backend has ended the session (e.g. for irrelevant/abusive messages) -
  // that's a deliberate cutoff, not something a shopper should be able to
  // shrug off by clicking "new chat"; a genuinely new conversation needs a
  // new tab (and so a new sessionId from scratch).
  const handleNewChat = () => {
    if (sessionEnded) return
    recognitionRef.current?.stop()
    const newSessionId = crypto.randomUUID()
    sessionStorage.setItem(SESSION_ID_KEY, newSessionId)
    setSessionId(newSessionId)
    setMessages([createGreeting()])
    setInputValue('')
    setIsSending(false)
    isSendingRef.current = false
    setSessionEnded(false)
    setCartStatusByVariant({})
    setCartHasItems(false)
    setAwaitingEmail(true)
    nameCorrectionOfferedRef.current = false
  }

  // Persisted to localStorage (see loadSoundMuted) so muting the typing/reply
  // blips sticks across tabs and new chats, like a real device volume switch
  // rather than a one-off toggle a shopper has to redo every session.
  const handleToggleSound = () => {
    setIsSoundMuted((prev) => {
      const next = !prev
      try {
        localStorage.setItem(SOUND_MUTED_KEY, String(next))
      } catch {
        // Storage can be unavailable (private browsing, etc.) - the toggle
        // still works for the rest of this tab's session either way.
      }
      return next
    })
  }

  const handleMicClick = () => {
    if (!SpeechRecognitionAPI) return

    if (isListening) {
      recognitionRef.current?.stop()
      return
    }

    const recognition = new SpeechRecognitionAPI()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript
      setInputValue((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript))
    }
    // Both onend (recognition stopped normally) and onerror (mic denied,
    // no speech detected, etc.) need to release the listening state -
    // otherwise the mic button gets stuck showing "recording".
    recognition.onend = () => setIsListening(false)
    recognition.onerror = () => setIsListening(false)

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }

  const handleDownloadTranscript = () => {
    const lines = messages.map((message) => {
      const time = formatCustomerTime(message.timestamp ?? new Date())
      const speaker = message.role === 'user' ? 'You' : 'VibeBuy'
      return `[${time}] ${speaker}: ${message.content ?? ''}`
    })
    const text = [`Here is your transcript with VibeBuy on ${sessionDate}.`, '', ...lines].join('\n')

    // Kept locale-independent (plain ISO yyyy-mm-dd, not the shopper's own
    // date convention) since this becomes a filename - some locales format
    // dates with characters that aren't safe there, and sorting stays
    // correct regardless of which shopper downloaded it.
    const fileDate = new Date().toISOString().slice(0, 10)

    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `chat-transcript-${fileDate}.txt`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // A single message with the info + email together is enough - the
  // backend finalizes as soon as it sees an email, no separate "done" turn
  // needed (that used to cost an extra model call just to re-render this
  // same form, for a reply the shopper never even saw). productInfo is
  // null for the email-only retry form, when only the email was
  // missing/invalid.
  const handleBulkFormSubmit = async (productInfo, email) => {
    const infoMessage = productInfo ? `${productInfo}, my email is ${email}` : `my email is ${email}`
    await sendMessage(infoMessage)
  }

  const handleEmailCaptureSubmit = async (email) => {
    // Set before the send (not inside sendMessage's own guard) - sendMessage
    // itself doesn't gate on awaitingEmail, since this very call needs to go
    // through while it's still true; the input row/suggestions/etc. staying
    // hidden until now is what actually enforces "email first" everywhere
    // else.
    setAwaitingEmail(false)
    await sendMessage(email)
  }

  // Updates the backend's session state directly (like handleAddToCart) -
  // it's a plain preference change, not something that needs a model turn -
  // then appends a local confirmation so the change is visible right away.
  const handleChangeNameSubmit = async (newName) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/customer-name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, name: newName }),
      })

      if (!res.ok) throw new Error(`Request failed with status ${res.status}`)

      const data = await res.json()
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Got it, I'll call you ${data.name} from now on!`,
          suggestions: data.suggestions,
          timestamp: new Date(),
        },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          isError: true,
          content: "Couldn't update your name. Please try again.",
          timestamp: new Date(),
        },
      ])
    }
  }

  const handleAddToCart = async (product) => {
    setCartStatusByVariant((prev) => ({ ...prev, [product.variantId]: 'adding' }))

    try {
      const res = await fetch(`${API_BASE_URL}/api/cart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, variantId: product.variantId, quantity: 1 }),
      })

      if (!res.ok) throw new Error(`Request failed with status ${res.status}`)

      const data = await res.json()
      setCartStatusByVariant((prev) => ({ ...prev, [product.variantId]: 'added' }))
      if (data.itemCount > 0) setCartHasItems(true)
      const cartMessage = {
        role: 'assistant',
        isCartSummary: true,
        content: `Added ${product.title} to your cart (qty ${data.quantity}).`,
        // Shows the cart's actual product cards (image, title, price,
        // qty) rather than a "Go to checkout" link - adding something
        // isn't the shopper asking to check out, and this confirms what's
        // actually in the cart now instead of just linking straight to
        // checkout.
        products: data.lineItems,
        // Same "View cart" link the chat path's own cart replies show (see
        // assistantMessageFrom's cartUrl) - added here too since this
        // direct mutation skips assistantMessageFrom entirely.
        cartUrl: data.cartUrl,
        // Direct cart mutation above skips Claude entirely for speed, so
        // there's no reply asking about similar items on its own - offer
        // it as a suggestion chip instead of sending it automatically, so
        // asking for it is the shopper's choice, not something typed for them.
        suggestions: [`What pairs well with ${product.title}?`],
        // Newly unlocked (or still-open) free-gift picks, if this add just
        // crossed the qualifying threshold - null once there's nothing left
        // to claim, same shape assistantMessageFrom uses for the chat path.
        freeGift: data.freeGift?.remainingSlots > 0 ? data.freeGift : null,
        timestamp: new Date(),
      }
      // Updates the existing cart-summary bubble in place (by index) instead
      // of deleting and re-appending it - a delete-and-re-add approach would
      // wipe the earlier "Added X to cart" confirmation out of the visible
      // transcript every time another product got added, which looks like
      // the widget is losing conversation history rather than just updating
      // a live cart total. Only appends a new bubble the first time.
      setMessages((prev) => {
        const existingIndex = prev.findIndex((message) => message.isCartSummary)
        if (existingIndex === -1) return [...prev, cartMessage]
        const next = [...prev]
        next[existingIndex] = cartMessage
        return next
      })
    } catch {
      setCartStatusByVariant((prev) => ({ ...prev, [product.variantId]: undefined }))
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          isError: true,
          content: `Couldn't add ${product.title} to your cart. Please try again.`,
          timestamp: new Date(),
        },
      ])
    }
  }

  // Mirrors handleAddToCart above (same direct-mutation, same
  // update-the-cart-summary-bubble-in-place approach) but hits /api/free-gift
  // instead, so the store's Buy-X-Get-Y code gets applied automatically -
  // the shopper just picks a card, they never need to know a code exists.
  const handleAddFreeGift = async (product) => {
    setFreeGiftStatusByVariant((prev) => ({ ...prev, [product.variantId]: 'adding' }))

    try {
      const res = await fetch(`${API_BASE_URL}/api/free-gift`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, variantId: product.variantId }),
      })

      if (!res.ok) throw new Error(`Request failed with status ${res.status}`)

      const data = await res.json()
      setFreeGiftStatusByVariant((prev) => ({ ...prev, [product.variantId]: 'added' }))
      if (data.itemCount > 0) setCartHasItems(true)
      const cartMessage = {
        role: 'assistant',
        isCartSummary: true,
        content: `Added your free ${product.title} to your cart!`,
        products: data.lineItems,
        cartUrl: data.cartUrl,
        freeGift: data.freeGift?.remainingSlots > 0 ? data.freeGift : null,
        timestamp: new Date(),
      }
      setMessages((prev) => {
        const existingIndex = prev.findIndex((message) => message.isCartSummary)
        if (existingIndex === -1) return [...prev, cartMessage]
        const next = [...prev]
        next[existingIndex] = cartMessage
        return next
      })
    } catch {
      setFreeGiftStatusByVariant((prev) => ({ ...prev, [product.variantId]: undefined }))
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          isError: true,
          content: `Couldn't add your free ${product.title}. Please try again.`,
          timestamp: new Date(),
        },
      ])
    }
  }

  // Handles the "Remove" button shown on cart cards once the shopper's asked
  // to remove something (see server.js's REMOVE_ITEM_RE reply, which sets
  // removalMode on that message) - same direct-mutation, quantity-0 request
  // /api/cart already supports for the "Add to cart" side.
  const handleRemoveItem = async (product) => {
    setCartStatusByVariant((prev) => ({ ...prev, [product.variantId]: 'removing' }))

    try {
      const res = await fetch(`${API_BASE_URL}/api/cart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, variantId: product.variantId, quantity: 0 }),
      })

      if (!res.ok) throw new Error(`Request failed with status ${res.status}`)

      const data = await res.json()
      setCartStatusByVariant((prev) => ({ ...prev, [product.variantId]: 'removed' }))
      setCartHasItems(data.itemCount > 0)
      const cartMessage = {
        role: 'assistant',
        isCartSummary: true,
        removalMode: data.itemCount > 0,
        content:
          data.itemCount > 0
            ? `Removed ${product.title} from your cart. I'm sorry it wasn't a fit! Want me to show you something else you might like?`
            : `Removed ${product.title} from your cart. Your cart's empty now. I'm sorry it wasn't a fit! Want me to show you something else you might like?`,
        suggestions: ['Show me snowboards', 'Browse popular products'],
        products: data.lineItems,
        cartUrl: data.cartUrl,
        freeGift: data.freeGift?.remainingSlots > 0 ? data.freeGift : null,
        timestamp: new Date(),
      }
      setMessages((prev) => {
        const existingIndex = prev.findIndex((message) => message.isCartSummary)
        if (existingIndex === -1) return [...prev, cartMessage]
        const next = [...prev]
        next[existingIndex] = cartMessage
        return next
      })
    } catch {
      setCartStatusByVariant((prev) => ({ ...prev, [product.variantId]: undefined }))
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          isError: true,
          content: `Couldn't remove ${product.title}. Please try again.`,
          timestamp: new Date(),
        },
      ])
    }
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        className="chat-widget__launcher"
        onClick={() => setIsOpen(true)}
        aria-label="Open chat"
      >
        <AgentIcon className="chat-widget__launcher-icon" />
      </button>
    )
  }

  return (
    <div
      className={['chat-widget', isDragging && 'chat-widget--dragging'].filter(Boolean).join(' ')}
      ref={widgetRef}
      onMouseMove={handleShineMove}
      onMouseLeave={handleShineLeave}
      style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      <div className="chat-widget__shine" ref={shineRef} />
      <div className="chat-widget__drag-handle" onMouseDown={handleDragStart}>
        <span className="chat-widget__logo">🤖</span>
        <div className="chat-widget__header-text">
          <span>VibeBuy</span>
        </div>
        <div className="chat-widget__header-actions">
          <button
            type="button"
            className="chat-widget__sound-btn"
            onClick={handleToggleSound}
            onMouseDown={(event) => event.stopPropagation()}
            aria-label={isSoundMuted ? 'Unmute chat sounds' : 'Mute chat sounds'}
            title={isSoundMuted ? 'Unmute chat sounds' : 'Mute chat sounds'}
          >
            {isSoundMuted ? (
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" />
                <path
                  d="M4 4l16 16"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" />
                <path
                  d="M15.8 8.7a5 5 0 010 6.6M18 6.5a8 8 0 010 11"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="chat-widget__new-chat-btn"
            onClick={handleNewChat}
            onMouseDown={(event) => event.stopPropagation()}
            disabled={sessionEnded}
            aria-label={sessionEnded ? 'Chat ended - open a new tab to start again' : 'Start new chat'}
            title={sessionEnded ? 'Chat ended - open a new tab to start again' : 'New chat'}
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M4 5.75A2.75 2.75 0 016.75 3h10.5A2.75 2.75 0 0120 5.75v6.5A2.75 2.75 0 0117.25 15H10l-4.2 3.6a.5.5 0 01-.8-.38V15h-.25A2.75 2.75 0 012 12.25v-6.5z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
              <path
                d="M11 6.5v4M9 8.5h4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <div className="chat-widget__menu-wrapper">
            <button
              type="button"
              className="chat-widget__menu-btn"
              onMouseDown={(event) => event.stopPropagation()}
              aria-label="More options"
            >
              ⋮
            </button>
            <div className="chat-widget__menu">
              <button
                type="button"
                className="chat-widget__menu-item"
                onClick={handleDownloadTranscript}
                onMouseDown={(event) => event.stopPropagation()}
              >
                Download transcript
              </button>
              <a
                className="chat-widget__menu-item"
                href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(SUPPORT_EMAIL)}`}
                target="_blank"
                rel="noopener noreferrer"
                onMouseDown={(event) => event.stopPropagation()}
              >
                Contact via Email
              </a>
              <a
                className={[
                  'chat-widget__menu-item',
                  !SUPPORT_WHATSAPP_NUMBER && 'chat-widget__menu-item--disabled',
                ]
                  .filter(Boolean)
                  .join(' ')}
                href={SUPPORT_WHATSAPP_NUMBER ? `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}` : undefined}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (!SUPPORT_WHATSAPP_NUMBER) event.preventDefault()
                }}
                onMouseDown={(event) => event.stopPropagation()}
              >
                Contact via WhatsApp
              </a>
            </div>
          </div>
          <button
            type="button"
            className="chat-widget__close-btn"
            onClick={() => setIsOpen(false)}
            onMouseDown={(event) => event.stopPropagation()}
            aria-label="Close chat"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="chat-widget__messages">
        <div className="chat-widget__date-divider">{sessionDate}</div>
        {messages.map((message, index) => (
          <div key={index} className="chat-widget__turn">
            <div className={`chat-widget__row chat-widget__row--${message.role}`}>
              {message.role === 'assistant' && index === messages.length - 1 && (
                <span className="chat-widget__bot-icon">🤖</span>
              )}
              <div
                className={[
                  'chat-widget__message',
                  `chat-widget__message--${message.role}`,
                  message.isError && 'chat-widget__message--error',
                  (message.checkoutUrl || message.cartUrl) && 'chat-widget__message--compact',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {message.content}
                {message.checkoutUrl && (
                  <a
                    className="chat-widget__cart-link"
                    href={message.checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Go to checkout ↗
                  </a>
                )}
                {message.cartUrl && (
                  <a
                    className="chat-widget__cart-link"
                    href={message.cartUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View cart ↗
                  </a>
                )}
              </div>
            </div>
            <CartItemGrids
              products={message.products}
              cartStatusByVariant={cartStatusByVariant}
              onAdd={handleAddToCart}
              onRemove={message.removalMode ? handleRemoveItem : undefined}
            />
            <FreeGiftPicker
              freeGift={message.freeGift}
              statusByVariant={freeGiftStatusByVariant}
              onAdd={handleAddFreeGift}
            />
            {index === messages.length - 1 && !isSending && message.bulkFormMode && (
              <BulkOrderForm mode={message.bulkFormMode} onSubmit={handleBulkFormSubmit} />
            )}
            {index === messages.length - 1 && !isSending && message.showEmailCapture && (
              <EmailCaptureForm onSubmit={handleEmailCaptureSubmit} />
            )}
            {index === messages.length - 1 && !isSending && message.greetName && (
              <ChangeNameForm currentName={message.greetName} onSubmit={handleChangeNameSubmit} />
            )}
            {index === messages.length - 1 && !isSending && !message.bulkFormMode && message.suggestions?.length > 0 && (
              <div className="suggestion-row">
                {message.suggestions.map((question) => (
                  <button
                    key={question}
                    type="button"
                    className="suggestion-chip"
                    onClick={() => handleSuggestionClick(question)}
                  >
                    {question}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {isSending && (
          <div className="chat-widget__row chat-widget__row--assistant">
            <span className="chat-widget__bot-icon">🤖</span>
            <div className="chat-widget__message chat-widget__message--assistant chat-widget__typing">
              <span className="chat-widget__typing-dot" />
              <span className="chat-widget__typing-dot" />
              <span className="chat-widget__typing-dot" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      {sessionEnded ? (
        <div className="chat-widget__ended-notice">Chat ended - open a new tab to start again.</div>
      ) : awaitingEmail ? (
        <div className="chat-widget__ended-notice">Please share your email above to start chatting.</div>
      ) : (
        <form className="chat-widget__input-row" onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="chat-widget__input"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder="Write what's on your mind..."
          />
          {SpeechRecognitionAPI && (
            <button
              type="button"
              className={['chat-widget__mic', isListening && 'chat-widget__mic--active']
                .filter(Boolean)
                .join(' ')}
              onClick={handleMicClick}
              disabled={isSending}
              aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
            >
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path
                  d="M12 14a3 3 0 003-3V6a3 3 0 10-6 0v5a3 3 0 003 3z"
                  fill="currentColor"
                />
                <path
                  d="M6 11a6 6 0 0012 0M12 17v3"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <button
            type="submit"
            className="chat-widget__send"
            disabled={isSending}
            aria-label="Send"
          >
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M3 11.5L21 3L12.5 21L10.5 13.5L3 11.5Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </form>
      )}
    </div>
  )
}

export default ChatWidget
