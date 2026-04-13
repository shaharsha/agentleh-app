import { createClient } from '@supabase/supabase-js'

// PKCE flow instead of the default implicit flow:
//  - OAuth callback uses ?code= instead of #access_token= — cleaner URL
//  - Code interception attacks mitigated (PKCE challenge/verifier)
//  - Access token stays out of browser history
// Requires Supabase JS v2.x which supports PKCE for browser clients.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      flowType: 'pkce',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  },
)
