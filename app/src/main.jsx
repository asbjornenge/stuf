import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/browser'
import './index.css'
import App from './App.jsx'

Sentry.init({
  dsn: 'https://aa4eb0c4591f4db18e29c0640e0653e0@sentry.asbjornenge.com/35',
  release: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown',
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err =>
    console.warn('SW registration failed:', err)
  );
}
