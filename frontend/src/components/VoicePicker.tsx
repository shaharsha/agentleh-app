/**
 * VoicePicker — grid of Gemini-TTS Hebrew voices with audio preview.
 *
 * Fetches the voice manifest from /api/voices/manifest once on mount and
 * renders a gender-filterable grid of voice cards. Clicking a card plays
 * that voice's pre-rendered OGG sample (the same short Hebrew phrase for
 * every voice, so they're directly comparable). Selecting a card lifts the
 * chosen voice name to the parent via onChange.
 *
 * Used in two places:
 *   - OnboardingPage — new step 2 ("choose your agent's voice")
 *   - DashboardPage — edit-voice modal on each agent card
 *
 * Design notes:
 *   - One <audio> element owned by the component (not per-card) so only
 *     one sample plays at a time and switching is instant.
 *   - Uses existing Tailwind glass design tokens — no new CSS.
 *   - Hebrew RTL is inherited from the surrounding <div dir="rtl">.
 *   - Gender labels are hardcoded Hebrew strings (no i18n framework in
 *     this repo — follows AGENTS.md and OnboardingPage precedent).
 *   - `url_dev` vs `url_prod` from the manifest: we pick based on
 *     import.meta.env.PROD which Vite evaluates at build time. In dev
 *     the bucket is gs://agentiko-public-assets-dev, in prod it's
 *     gs://agentiko-public-assets.
 */

import { useEffect, useRef, useState } from 'react'

/* ───────────────────────────────────────────────────────────
 * Types + fetch are inlined here rather than imported from
 * lib/api so this component is self-contained and doesn't
 * depend on the multi-tenancy helpers being merged first.
 * When lib/api gains the voice helpers they can be imported
 * here as a one-line refactor.
 * ─────────────────────────────────────────────────────────── */

interface VoiceManifestEntry {
  name: string
  gender: 'female' | 'male'
  is_default: boolean
  sample_path: string
  size_bytes: number
  url_prod: string
  url_dev: string
}

interface VoiceManifest {
  model: string
  language_code: string
  sample_text: string
  default_voice: string
  voices: VoiceManifestEntry[]
}

async function fetchVoiceManifest(): Promise<VoiceManifest> {
  const res = await fetch('/api/voices/manifest')
  if (!res.ok) throw new Error('Voice manifest fetch failed')
  return res.json()
}

interface VoicePickerProps {
  value: string
  onChange: (voiceName: string) => void
  /** Optional — override the manifest-driven default when a pre-selected value should win. */
  fallbackDefault?: string
  /**
   * When set, the voice picker is locked to this gender: the gender-filter
   * buttons are hidden and the grid only shows matching voices. The parent
   * component owns the gender toggle (radio button above) so the bot_gender
   * DB field and the voice list stay in lockstep. If lockedGender changes
   * to a value that doesn't match the current `value`, the picker emits
   * an onChange with the manifest's default voice for the new gender.
   */
  lockedGender?: 'male' | 'female'
}

type GenderFilter = 'all' | 'female' | 'male'

export default function VoicePicker({
  value,
  onChange,
  fallbackDefault,
  lockedGender,
}: VoicePickerProps) {
  const [manifest, setManifest] = useState<VoiceManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<GenderFilter>('all')
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchVoiceManifest()
      .then((m: VoiceManifest) => {
        if (cancelled) return
        setManifest(m)
        // If the caller didn't pre-select a voice, default to the manifest's
        // default_voice (currently 'Kore') so the submit button lights up.
        if (!value && !fallbackDefault) {
          onChange(m.default_voice)
        } else if (!value && fallbackDefault) {
          onChange(fallbackDefault)
        }
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message || 'Failed to load voices')
      })
    return () => {
      cancelled = true
    }
    // Intentionally run once on mount. onChange + fallbackDefault are
    // unstable across renders; we only care about the initial bootstrap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // Clean up audio on unmount so a previewing sample doesn't keep
    // playing after the modal closes.
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
      }
    }
  }, [])

  // When the parent toggles lockedGender and the currently-selected voice
  // doesn't belong to the new gender, snap the selection to that gender's
  // first voice. Keeps the picker in a consistent state so there's never
  // a male-gender-with-Kore-selected moment.
  useEffect(() => {
    if (!manifest || !lockedGender) return
    const selectedEntry = manifest.voices.find(
      (v: VoiceManifestEntry) => v.name === value,
    )
    if (selectedEntry && selectedEntry.gender === lockedGender) return
    const preferredDefault = lockedGender === 'male' ? 'Puck' : 'Kore'
    const pick =
      manifest.voices.find(
        (v: VoiceManifestEntry) =>
          v.gender === lockedGender && v.name === preferredDefault,
      ) ||
      manifest.voices.find((v: VoiceManifestEntry) => v.gender === lockedGender)
    if (pick) onChange(pick.name)
    // onChange is not stable — run only when lockedGender or manifest changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedGender, manifest])

  function playSample(voice: VoiceManifestEntry) {
    // Hot-swap the single <audio> element's src. Using one element (not
    // per-card <audio>) means switching voices stops the previous one
    // automatically — no manual pause orchestration.
    const url = import.meta.env.PROD ? voice.url_prod : voice.url_dev
    if (!audioRef.current) {
      audioRef.current = new Audio(url)
    } else {
      audioRef.current.src = url
    }
    audioRef.current.onended = () => setPlaying(null)
    audioRef.current.onerror = () => setPlaying(null)
    audioRef.current
      .play()
      .then(() => setPlaying(voice.name))
      .catch(() => setPlaying(null))
  }

  function selectVoice(voice: VoiceManifestEntry) {
    onChange(voice.name)
    playSample(voice)
  }

  if (error) {
    return (
      <div className="glass-card rounded-[16px] p-4 text-center text-[13px] text-text-secondary">
        לא הצלחנו לטעון את רשימת הקולות. נסה לרענן את הדף.
      </div>
    )
  }

  if (!manifest) {
    return (
      <div className="glass-card rounded-[16px] p-4 text-center text-[13px] text-text-secondary">
        טוען קולות...
      </div>
    )
  }

  // When lockedGender is set, only show matching voices and hide the
  // gender toggle entirely — the parent owns gender selection above.
  const effectiveGenderFilter: GenderFilter = lockedGender ?? filter
  const filtered = manifest.voices.filter((v: VoiceManifestEntry) => {
    if (effectiveGenderFilter === 'all') return true
    return v.gender === effectiveGenderFilter
  })

  return (
    <div className="space-y-4">
      {/* Gender filter — hidden when the parent locks gender via the prop */}
      {!lockedGender && (
        <div className="flex gap-2">
          <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
            הכל ({manifest.voices.length})
          </FilterButton>
          <FilterButton
            active={filter === 'female'}
            onClick={() => setFilter('female')}
          >
            נשיים ({manifest.voices.filter((v: VoiceManifestEntry) => v.gender === 'female').length})
          </FilterButton>
          <FilterButton active={filter === 'male'} onClick={() => setFilter('male')}>
            גבריים ({manifest.voices.filter((v: VoiceManifestEntry) => v.gender === 'male').length})
          </FilterButton>
        </div>
      )}

      {/* Sample text — same phrase every voice speaks, so users compare apples-to-apples */}
      <div className="text-[12px] text-text-secondary text-center">
        הקלטת הדגמה: "{manifest.sample_text}"
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[360px] overflow-y-auto">
        {filtered.map((voice: VoiceManifestEntry) => {
          const isSelected = voice.name === value
          const isPlaying = playing === voice.name
          return (
            <button
              key={voice.name}
              type="button"
              onClick={() => selectVoice(voice)}
              className={`relative glass-card rounded-[16px] px-3 py-3 text-right transition-all ${
                isSelected
                  ? 'ring-2 ring-brand-500 bg-brand-50/40'
                  : 'hover:bg-white/60'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-semibold truncate">
                    {voice.name}
                  </div>
                  <div className="text-[11px] text-text-secondary">
                    {voice.gender === 'female' ? 'נשי' : 'גברי'}
                  </div>
                </div>
                <PlayIcon playing={isPlaying} />
              </div>
              {isSelected && (
                <div className="absolute top-1.5 left-1.5 w-4 h-4 rounded-full bg-brand-500 flex items-center justify-center">
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn-sm ${active ? 'btn-brand' : 'btn-secondary'}`}
    >
      {children}
    </button>
  )
}

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
        playing ? 'bg-brand-500 text-white' : 'bg-white/80 text-brand-500'
      }`}
    >
      {playing ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="8 5 19 12 8 19 8 5" />
        </svg>
      )}
    </div>
  )
}
