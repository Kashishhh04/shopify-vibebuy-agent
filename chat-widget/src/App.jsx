import ChatWidget from './ChatWidget'

// This is the entire embedded page: on the storefront, ChatWidget floats on
// top of the theme's own page content via its own fixed positioning. The
// old Vite/React starter boilerplate that used to render alongside it here
// (hero image, "Get started" counter, doc/social links) was harmless on the
// local dev server's own blank page, but would have rendered as unstyled
// leftover template content on top of the real storefront - removed rather
// than kept for a "demo" this project never used.
function App() {
  return <ChatWidget />
}

export default App
