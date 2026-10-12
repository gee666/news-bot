import { z } from 'zod';
import type { RenderedMessage } from './render.js';

const messageSchema = z.object({ message_id: z.number().int().positive(), chat: z.object({ id: z.number().int() }) });
const userSchema = z.object({ id: z.number().int().positive(), is_bot: z.boolean() });
export class BotError extends Error {
  constructor(readonly code: string, readonly outcome: 'unknown' | 'retryable' | 'failed', readonly retryAfterMs = 0) {
    super(code);
  }
}
const envelopeSchema = z.object({
  ok: z.boolean(), result: z.unknown().optional(), error_code: z.number().optional(), description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().nonnegative().optional() }).optional(),
});

export class BotApi {
  constructor(private readonly token = process.env.TELEGRAM_BOT_TOKEN?.trim(), private readonly fetcher = fetch) {
    if (!token || !/^\d+:[A-Za-z0-9_-]+$/u.test(token)) throw new BotError('bot_token_missing_or_invalid', 'failed');
  }

  private botIdentity: { id: number; is_bot: boolean } | undefined;

  private async call(method: string, payload: object): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new BotError('telegram_transport_unknown', 'unknown'); }
    let body: unknown;
    try { body = await response.json(); } catch { throw new BotError('telegram_response_unknown', 'unknown'); }
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) throw new BotError('telegram_response_unknown', 'unknown');
    const value = parsed.data;
    if (value.ok) return value.result;
    if (value.error_code === 429) throw new BotError('telegram_rate_limit', 'retryable', (value.parameters?.retry_after ?? 60) * 1000);
    if (method === 'editMessageText' && value.error_code === 400 && value.description?.includes('message is not modified')) return true;
    if (method === 'deleteMessage' && value.error_code === 400 && value.description?.includes('message to delete not found')) return true;
    // A server error may occur after the operation took effect.
    if (response.status >= 500 || (value.error_code ?? 0) >= 500) throw new BotError('telegram_server_unknown', 'unknown');
    throw new BotError(`telegram_rejected_${value.error_code ?? response.status}`, 'failed');
  }

  async identity(): Promise<{ id: number; is_bot: boolean }> {
    try {
      this.botIdentity ??= userSchema.parse(await this.call('getMe', {}));
      if (!this.botIdentity.is_bot) throw new BotError('telegram_identity_invalid', 'failed');
      return this.botIdentity;
    }
    catch (error) { if (error instanceof BotError) throw error; throw new BotError('telegram_identity_invalid', 'failed'); }
  }

  async send(destinationId: string, message: RenderedMessage): Promise<string> {
    const { text, parse_mode, link_preview_options, reply_markup } = message;
    const value = await this.call('sendMessage', { chat_id: destinationId, text, parse_mode, link_preview_options, reply_markup });
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success || String(parsed.data.chat.id) !== destinationId) throw new BotError('telegram_send_response_unknown', 'unknown');
    return String(parsed.data.message_id);
  }

  async edit(destinationId: string, messageId: string, message: RenderedMessage): Promise<void> {
    const { text, parse_mode, link_preview_options, reply_markup } = message;
    const value = await this.call('editMessageText', { chat_id: destinationId, message_id: Number(messageId), text, parse_mode, link_preview_options, reply_markup });
    if (value === true) return;
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success || String(parsed.data.chat.id) !== destinationId || String(parsed.data.message_id) !== messageId) {
      throw new BotError('telegram_edit_response_unknown', 'unknown');
    }
  }

  async delete(destinationId: string, messageId: string): Promise<void> {
    if (await this.call('deleteMessage', { chat_id: destinationId, message_id: Number(messageId) }) !== true) {
      throw new BotError('telegram_delete_response_unknown', 'unknown');
    }
  }
}
