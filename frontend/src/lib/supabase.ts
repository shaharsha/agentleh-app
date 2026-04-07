import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://mnetqtjwcdunznvvfaob.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1uZXRxdGp3Y2R1bnpudnZmYW9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NDc0NTMsImV4cCI6MjA5MTEyMzQ1M30.QdtX_YczXzokSS6vfqDcMFGQcZFPCmgT4Arspvb8I8c'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
