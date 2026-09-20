import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// #root exists in this project's own index.html for local dev, but an
// actual Shopify theme page (where this script gets embedded via a plain
// <script> tag) has no such element - the widget has to create its own
// mount point there instead of assuming one is already present.
let container = document.getElementById('root')
if (!container) {
  container = document.createElement('div')
  container.id = 'root'
  document.body.appendChild(container)
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
