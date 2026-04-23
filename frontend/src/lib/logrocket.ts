import LogRocket from 'logrocket'

const SENSITIVE_PATH_PREFIXES = ['/api/', '/auth/v1/', '/rest/v1/']

function isHeaderRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null
}

function shouldStripBody(url?: string | null): boolean {
  return SENSITIVE_PATH_PREFIXES.some((prefix) => url?.includes(prefix))
}

function redactHeader(headers: unknown, key: string): void {
  if (!isHeaderRecord(headers)) return
  if (headers[key]) headers[key] = '[REDACTED]'
}

export function initLogRocket(): void {
  const appId = import.meta.env.VITE_LOGROCKET_APP_ID
  if (!appId) return

  LogRocket.init(appId, {
    dom: {
      inputSanitizer: true,
      textSanitizer: true,
    },
    network: {
      requestSanitizer: (request) => {
        redactHeader(request.headers, 'Authorization')
        redactHeader(request.headers, 'authorization')
        redactHeader(request.headers, 'apikey')

        if (shouldStripBody(request.url)) {
          request.body = undefined
        }

        return request
      },
      responseSanitizer: (response) => {
        if (shouldStripBody(response.url)) {
          response.body = undefined
        }

        return response
      },
    },
  })
}

export function identifyUser(user: {
  id: number
  email: string
  full_name: string
  role: string
  default_tenant_id?: number | null
}): void {
  const traits: Record<string, string | number | boolean> = {
    email: user.email,
    name: user.full_name,
    role: user.role,
  }

  if (user.default_tenant_id != null) {
    traits.defaultTenantId = user.default_tenant_id
  }

  LogRocket.identify(String(user.id), traits)
}
