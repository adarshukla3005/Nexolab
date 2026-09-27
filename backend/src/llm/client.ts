// LLM client: LiteLLM proxy via OpenAI-compat SDK (dec-llm-litellm-proxy)
import OpenAI from 'openai'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/index.js'
import { query } from '../db.js'

let _client: OpenAI | null = null

// Default 45s cap for orchestrator stage turns (small prompts, fast tool loops).
// Workspace chat overrides via ChatOptions.timeoutMs — its prompts are bigger.
const DEFAULT_LLM_TIMEOUT_MS = 45_000
const MAX_LLM_TIMEOUT_MS = 180_000 // absolute ceiling — client timeout must be at least this big.

function getClient(): OpenAI {
  if (_client) return _client
  const baseURL = process.env.LITELLM_BASE_URL
  const apiKey = process.env.LITELLM_API_KEY
  if (!baseURL || !apiKey) throw new Error('LITELLM_BASE_URL and LITELLM_API_KEY are required')
  // Give the SDK enough headroom that our AbortController fires first, not the SDK.
  _client = new OpenAI({ baseURL, apiKey, timeout: MAX_LLM_TIMEOUT_MS, maxRetries: 0 })
  return _client
}

export interface ChatOptions {
  model?: string
  tools?: ChatCompletionTool[]
  featureId?: string
  stageRunId?: string
  maxTokens?: number
  /** Per-call hard timeout in milliseconds (default 45s). Bounded to MAX_LLM_TIMEOUT_MS. */
  timeoutMs?: number
}

export interface ChatResult {
  message: OpenAI.Chat.ChatCompletionMessage
  tokensIn: number
  tokensOut: number
}

const RETRY_DELAYS = [2000, 5000] // 2 retries after the initial attempt — fail fast

export async function chat(
  messages: ChatCompletionMessageParam[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const model = opts.model ?? process.env.LITELLM_MODEL ?? 'claude-3-5-sonnet'
  const client = getClient()

  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages,
        max_tokens: opts.maxTokens ?? 4096,
      }
      if (opts.tools && opts.tools.length > 0) {
        params.tools = opts.tools
        params.tool_choice = 'auto'
      }

      // Hard timeout via AbortController — the SDK's `timeout` option is unreliable
      // through the LiteLLM proxy, so we enforce it ourselves.
      const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS)
      const abortCtrl = new AbortController()
      const timeoutHandle = setTimeout(() => abortCtrl.abort(), timeoutMs)

      const callStart = Date.now()
      const heartbeat = setInterval(() => {
        const elapsed = Math.round((Date.now() - callStart) / 1000)
        console.log(`[llm] waiting for response… ${elapsed}s (feature=${opts.featureId ?? '?'})`)
      }, 15_000)

      let resp: OpenAI.Chat.ChatCompletion
      try {
        resp = await client.chat.completions.create(params, { signal: abortCtrl.signal })
      } finally {
        clearInterval(heartbeat)
        clearTimeout(timeoutHandle)
      }
      const tokensIn = resp.usage?.prompt_tokens ?? 0
      const tokensOut = resp.usage?.completion_tokens ?? 0

      // Emit llm_event
      if (opts.featureId || opts.stageRunId) {
        await query(
          `INSERT INTO llm_events (feature_id, stage_run_id, model, tokens_in, tokens_out)
           VALUES ($1, $2, $3, $4, $5)`,
          [opts.featureId ?? null, opts.stageRunId ?? null, model, tokensIn, tokensOut],
        ).catch((e) => console.warn('[llm] failed to emit event:', e))
      }

      return { message: resp.choices[0].message, tokensIn, tokensOut }
    } catch (err) {
      lastErr = err
      // Fail fast on DNS / network unreachability. Retrying these just wastes minutes and
      // stacks up unhelpful log noise — the network isn't going to fix itself in 2 seconds.
      const errStr = err instanceof Error ? `${err.message} ${(err as unknown as { cause?: { code?: string; message?: string } }).cause?.code ?? ''} ${(err as unknown as { cause?: { message?: string } }).cause?.message ?? ''}` : String(err)
      const isUnrecoverableNetwork = /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|getaddrinfo/i.test(errStr)
      if (isUnrecoverableNetwork) {
        console.error(`[llm] unrecoverable network error, giving up: ${errStr.slice(0, 200)}`)
        throw err
      }
      if (attempt < RETRY_DELAYS.length) {
        console.warn(`[llm] attempt ${attempt + 1} failed, retrying:`, err)
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      }
    }
  }
  throw lastErr
}
