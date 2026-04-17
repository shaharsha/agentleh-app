import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { I18nProvider } from './lib/i18n'
// Initialises the theme store at module scope (OS listener, cross-tab
// `storage` listener, hydrate from localStorage). No provider component
// needed — useTheme reads from the module-level store via
// useSyncExternalStore.
import './lib/themeStore'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
