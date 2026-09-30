/**
 * Загрузка файла с диска на CDN Тильды. Node читает файл сам и передаёт содержимое
 * в страницу редактора аргументом вызова слоя `tilda-upload.js` (`uploadImageFromDataUrl`);
 * через контекст агента base64 не проходит. Результат — поля для `set.image` плана:
 * img, filewidth, fileheight (height элемента пересчитает setImage).
 *
 *   validateFile(path)            → { path, name, bytes, mime } либо ошибка (тип, размер)
 *   toDataUrl(buffer, mime)       → data:-адрес
 *   imageSpecFromUpload(result)   → { img, filewidth, fileheight }
 *   upload(driver, path, opts)    → { ...result, image: {img, filewidth, fileheight} }
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { createLogger } from './lib/log.mjs';
import { msg } from './lib/i18n.mjs';
import { ToolError } from './lib/tool-error.mjs';

const log = createLogger('upload');

/** Разрешённые типы — то, что CDN Тильды принимает как картинку (проверено 2026-09-03 для png). */
export const ALLOWED_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
});
/** Предел размера файла — лимит редактора Тильды на картинку. */
export const MAX_BYTES = 20 * 1024 * 1024;

/** Проверка до обращения к CDN: файл есть, тип из списка, размер в пределе. */
export function validateFile(path, { maxBytes = MAX_BYTES } = {}) {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    log.error('validateFile', 'file not found', { path: abs });
    throw new ToolError('FILE_NOT_FOUND', msg('upload.fileNotFound', { path: abs }));
  }
  const ext = extname(abs).toLowerCase();
  const mime = ALLOWED_TYPES[ext];
  if (!mime) {
    log.error('validateFile', 'file type is not allowed', { path: abs, ext, allowed: Object.keys(ALLOWED_TYPES) });
    throw new ToolError('FILE_TYPE_REJECTED', msg('upload.fileTypeRejected', { ext: ext || msg('upload.noExtension'), allowed: Object.keys(ALLOWED_TYPES).join(', ') }));
  }
  const bytes = statSync(abs).size;
  if (bytes === 0 || bytes > maxBytes) {
    log.error('validateFile', 'file size out of limit', { path: abs, bytes, maxBytes });
    throw new ToolError('FILE_SIZE_REJECTED', msg('upload.fileSizeRejected', { bytes, maxBytes }));
  }
  log.debug('validateFile', 'file accepted', { path: abs, name: basename(abs), bytes, mime });
  return { path: abs, name: basename(abs), bytes, mime };
}

export function toDataUrl(buffer, mime) {
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

/** Ответ CDN → поля операции set.image. */
export function imageSpecFromUpload(result) {
  if (!result || !result.cdnUrl) throw new ToolError('UPLOAD_FAILED', msg('upload.noCdnUrl'));
  if (!/^https:\/\/static\.tildacdn\.com\//.test(result.cdnUrl)) throw new ToolError('UPLOAD_FAILED', msg('upload.unexpectedUrl', { cdnUrl: result.cdnUrl }));
  const filewidth = Number(result.width);
  const fileheight = Number(result.height);
  if (!Number.isFinite(filewidth) || !Number.isFinite(fileheight) || filewidth <= 0 || fileheight <= 0) throw new ToolError('UPLOAD_FAILED', msg('upload.noSize', { width: result.width, height: result.height }));
  return { img: result.cdnUrl, filewidth: String(filewidth), fileheight: String(fileheight) };
}

/**
 * Загрузить файл через открытый редактор. driver — { call } цикла (слой tilda-upload должен быть
 * установлен). Возвращает ответ CDN плюс готовый image-spec.
 */
export async function upload(driver, path, opts = {}) {
  const file = validateFile(path, opts);
  const dataUrl = toDataUrl(readFileSync(file.path), file.mime);
  log.debug('upload', 'sending', { name: file.name, bytes: file.bytes, mime: file.mime, dataUrlBytes: dataUrl.length });
  const started = Date.now();
  const result = await driver.call('uploadImageFromDataUrl', [dataUrl, file.name], { timeoutMs: opts.timeoutMs ?? 180_000 });
  const image = imageSpecFromUpload(result);
  log.debug('upload', 'CDN response', { uuid: result.uuid, url: result.cdnUrl, width: result.width, height: result.height, ms: Date.now() - started });
  log.info('upload', `uploaded ${file.name} → ${result.cdnUrl}`, { bytes: file.bytes, width: result.width, height: result.height });
  return { ...result, file: file.name, bytes: file.bytes, image };
}
