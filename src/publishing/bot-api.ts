import { z } from 'zod';
import type { RenderedMessage } from './render.js';
export interface TelegramTimeouts { requestMs: number; uploadMs: number }

function timeout(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined ? fallback : /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 1_000 || value > maximum) {
    // Never echo environment values, which may contain accidentally pasted credentials.
    throw new Error(`${name.toLowerCase()}_invalid`);
  }
  return value;
}

/** Read and validate before recording an attempt; multipart uploads use uploadMs. */
export function telegramTimeouts(): TelegramTimeouts {
  return {
    requestMs: timeout('TELEGRAM_REQUEST_TIMEOUT_MS', 30_000, 300_000),
    uploadMs: timeout('TELEGRAM_UPLOAD_TIMEOUT_MS', 300_000, 900_000),
  };
}

function preconnectCause(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 8 || error.cause !== undefined
    || error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = 'code' in error ? error.code : undefined;
  const syscall = 'syscall' in error ? error.syscall : undefined;
  if (error instanceof AggregateError) {
    // Node's multi-address connect can aggregate failures. Every address must have
    // failed before connection, not merely the first error or the aggregate code.
    if ((code !== undefined && code !== 'ECONNREFUSED' && code !== 'ENETUNREACH')
      || (syscall !== undefined && syscall !== 'connect')) return false;
    return Array.isArray(error.errors) && error.errors.length > 0 && error.errors.length <= 32
      && Array.from(error.errors).every((entry: unknown) => preconnectCause(entry, depth + 1));
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return error.name === 'ConnectTimeoutError' && syscall === undefined;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return syscall === 'getaddrinfo';
  return (code === 'ECONNREFUSED' || code === 'ENETUNREACH') && syscall === 'connect';
}

/** Only recognize Node/undici fetch failures with evidence that no HTTP bytes were sent. */
export function isTelegramPreconnectFailure(error: unknown): boolean {
  return error instanceof TypeError && error.name === 'TypeError' && error.message === 'fetch failed'
    && preconnectCause(error.cause);
}

export const MAX_ALBUM_MEDIA = 10;
// Leave room below Telegram's 50 MB request limit for multipart fields and headers.
export const MAX_MEDIA_BATCH_BYTES = 45_000_000;

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

export interface PublicationMedia { type: 'image' | 'video'; data: Buffer; mimeType: string; expiresAt?: number }

export function mediaUploadType(item: Pick<PublicationMedia, 'type' | 'mimeType'>): 'photo' | 'video' | 'document' {
  const mime = item.mimeType.toLowerCase();
  if (item.type === 'image' && ['image/jpeg', 'image/png'].includes(mime)) return 'photo';
  if (item.type === 'video' && mime === 'video/mp4') return 'video';
  return 'document';
}

function mediaExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  };
  return extensions[mimeType.toLowerCase()] ?? 'bin';
}

export class BotApi {
  constructor(private readonly token = process.env.TELEGRAM_BOT_TOKEN?.trim(), private readonly fetcher = fetch) {
    if (!token || !/^\d+:[A-Za-z0-9_-]+$/u.test(token)) throw new BotError('bot_token_missing_or_invalid', 'failed');
  }

  private botIdentity: { id: number; is_bot: boolean } | undefined;

  private async call(method: string, payload: object | FormData): Promise<unknown> {
    const { requestMs, uploadMs } = telegramTimeouts();
    const timeoutMs = payload instanceof FormData ? uploadMs : requestMs;
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        // Do not follow a response to another host, then mistake its connect failure for an unsent request.
        redirect: 'error', method: 'POST', ...(payload instanceof FormData
          ? { body: payload }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTelegramPreconnectFailure(error)) throw new BotError('telegram_connect_failed', 'retryable');
      throw new BotError('telegram_transport_unknown', 'unknown');
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new BotError('telegram_response_unknown', 'unknown'); }
    const parsed = envelopeSchema.safeParse(body);
    if (!parsed.success) throw new BotError('telegram_response_unknown', 'unknown');
    const value = parsed.data;
    if (value.ok) return value.result;
    if (value.error_code === 429) throw new BotError('telegram_rate_limit', 'retryable', (value.parameters?.retry_after ?? 60) * 1000);
    if ((method === 'editMessageText' || method === 'editMessageCaption') && value.error_code === 400 && value.description?.includes('message is not modified')) return true;
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

  async send(destinationId: string, message: RenderedMessage, replyTo?: string): Promise<string> {
    if (replyTo !== undefined) throw new BotError('publication_replies_forbidden', 'failed');
    const { text, parse_mode, link_preview_options, reply_markup } = message;
    const value = await this.call('sendMessage', { chat_id: destinationId, text, parse_mode, link_preview_options, reply_markup });
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success || String(parsed.data.chat.id) !== destinationId) throw new BotError('telegram_send_response_unknown', 'unknown');
    return String(parsed.data.message_id);
  }

  /** Text stays in the canonical message, so attachments never truncate it to a caption. */
  async sendMedia(destinationId: string, replyTo: string | undefined, media: PublicationMedia[]): Promise<string[]> {
    if (replyTo !== undefined) throw new BotError('publication_replies_forbidden', 'failed');
    if (!media.length || media.length > 10
      || media.some(item => !item.data.length || !(item.type === 'image' || item.type === 'video'))) {
      throw new BotError('telegram_media_invalid', 'failed');
    }
    if (media.reduce((bytes, item) => bytes + item.data.length, 0) > MAX_MEDIA_BATCH_BYTES) {
      throw new BotError('publication_media_too_large', 'failed');
    }
    const uploads = media.map(mediaUploadType);
    const documents = uploads.every(type => type === 'document');
    if (!documents && uploads.includes('document')) throw new BotError('telegram_media_batch_invalid', 'failed');
    const form = new FormData();
    form.set('chat_id', destinationId);
    const single = media.length === 1 ? media[0] : undefined;
    media.forEach((item, index) => {
      const field = single ? mediaUploadType(item) : `file${index}`;
      form.set(field, new Blob([new Uint8Array(item.data)], { type: item.mimeType }), `${field}.${mediaExtension(item.mimeType)}`);
    });
    if (single && documents) form.set('disable_content_type_detection', 'true');
    if (!single) form.set('media', JSON.stringify(media.map((item, index) => ({
      type: mediaUploadType(item), media: `attach://file${index}`, ...(documents ? { disable_content_type_detection: true } : {}),
    }))));
    const method = !single ? 'sendMediaGroup' : documents ? 'sendDocument' : mediaUploadType(single) === 'photo' ? 'sendPhoto' : 'sendVideo';
    const value = await this.call(method, form);
    const parsed = z.array(messageSchema).safeParse(single ? [value] : value);
    if (!parsed.success || parsed.data.length !== media.length || parsed.data.some(item => String(item.chat.id) !== destinationId)
      || new Set(parsed.data.map(item => item.message_id)).size !== media.length) {
      throw new BotError('telegram_media_response_unknown', 'unknown');
    }
    return parsed.data.map(item => String(item.message_id));
  }

  async editCaption(destinationId: string, messageId: string, message: RenderedMessage): Promise<void> {
    if (message.plainText.length > 1024) throw new BotError('telegram_caption_invalid', 'failed');
    const value = await this.call('editMessageCaption', { chat_id: destinationId, message_id: Number(messageId),
      caption: message.text, parse_mode: message.parse_mode });
    if (value === true) return;
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success || String(parsed.data.chat.id) !== destinationId || String(parsed.data.message_id) !== messageId) {
      throw new BotError('telegram_edit_response_unknown', 'unknown');
    }
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
