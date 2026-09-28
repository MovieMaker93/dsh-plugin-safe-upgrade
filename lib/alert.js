/**
 * Optional Telegram alerts for upgrade, rollback and recovery outcomes.
 * Credentials are read at send time from the environment or an env file, so
 * they never pass through job files or the plugin config.
 * @module dsh-plugin-safe-upgrade/alert
 */

import { readEnvFile } from './util.js'

/**
 * @param {{envFile?: string, tokenVar?: string, chatVar?: string} | undefined} config
 * @returns {{token: string, chat: string} | undefined}
 */
export function telegramCredentials(config, env = process.env) {
  if (config === undefined || config === null) return undefined
  const tokenVar = config.tokenVar ?? 'TELEGRAM_BOT_TOKEN'
  const chatVar = config.chatVar ?? 'TELEGRAM_CHAT_ID'
  const fileEnv = config.envFile ? readEnvFile(config.envFile) : {}
  const token = (fileEnv[tokenVar] ?? env[tokenVar] ?? '').trim()
  const chat = (fileEnv[chatVar] ?? env[chatVar] ?? '').trim()
  return token && chat ? { token, chat } : undefined
}

/**
 * Send one message; never throws (an alert must not turn a rollback into a
 * failure).
 * @returns {Promise<boolean>} whether Telegram accepted it.
 */
export async function sendAlert(config, text, { fetchImpl = fetch, log = () => {} } = {}) {
  const creds = telegramCredentials(config)
  if (creds === undefined) return false
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: creds.chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) log(`telegram alert rejected: HTTP ${response.status}`)
    return response.ok
  } catch (error) {
    log(`telegram alert failed: ${error?.message ?? error}`)
    return false
  }
}
