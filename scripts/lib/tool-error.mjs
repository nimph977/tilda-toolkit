/**
 * Ошибка модуля команды с машинным кодом и ключом словаря.
 *
 * `message` — английский текст с кодом в начале (`КОД: текст`): код ищут регулярками по тексту
 * (`isRetryable`, `calibrate.mjs`, `promote.mjs`), поэтому префикс сохраняется. Текст для
 * пользователя строит граница CLI по `key` и `params`.
 */
import { attachMessage, messageText } from './i18n.mjs';

export class ToolError extends Error {
  /**
   * @param {string} code машинный код (`SAVE_FAILED`, `PLAN_INVALID`)
   * @param {string|import('./i18n.mjs').Message} message строка или `Message`
   * @param {object} [data] дополнительные поля ошибки
   */
  constructor(code, message, data = {}) {
    const text = messageText(message);
    super(text.startsWith(code) ? text : `${code}: ${text}`);
    attachMessage(this, message);
    this.name = 'ToolError';
    this.code = code;
    this.exitCode = 1;
    Object.assign(this, data);
  }
}
