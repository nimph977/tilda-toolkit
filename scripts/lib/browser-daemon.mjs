/**
 * Держатель браузера: отдельный процесс, который поднимает Chrome с постоянным профилем
 * и держит его открытым между командами CLI. Запускается `browser.startDaemon()` (или
 * `node scripts/tilda.mjs browser start`), останавливается `stopDaemon()` — по CDP
 * закрывается Chrome, и этот процесс завершается сам.
 *
 * Пишет `<профиль>/daemon.json` = { pid, port, startedAt, minimized }; порт CDP берётся из
 * файла DevToolsActivePort, который Chrome кладёт в каталог профиля. Лог — daemon.log там же.
 */
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchOwned, profileDir, readDevToolsPort, DAEMON_FILE } from './browser.mjs';
import { createLogger } from './log.mjs';

const log = createLogger('browser-daemon');
const dir = profileDir();
const daemonFile = resolve(dir, DAEMON_FILE);

// Держатель только держит Chrome и ничего не редактирует: список защищённых страниц применяется
// в сессии каждой команды (`attach` → `installLayers`), поэтому TILDA_PROTECTED_PAGES здесь не нужна —
// иначе `reference fetch` без конфигурации Tilda не мог бы поднять держатель (2026-09-22).
const session = await launchOwned({ profileDir: dir, cdpPort: true, protectedPages: [] });

let port = null;
for (let i = 0; i < 50 && !port; i += 1) {
  port = readDevToolsPort(dir);
  if (!port) await new Promise((r) => setTimeout(r, 100));
}
if (!port) {
  log.error('main', 'Chrome did not open the CDP port (no DevToolsActivePort)', { dir });
  await session.context.close();
  process.exit(1);
}

writeFileSync(daemonFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), minimized: session.minimized }));
log.info('main', 'holder ready', { pid: process.pid, port, profileDir: dir });

const cleanup = () => {
  try {
    if (existsSync(daemonFile)) unlinkSync(daemonFile);
  } catch {
    /* ничего */
  }
};

session.context.on('close', () => {
  log.info('main', 'browser closed, holder exiting', { pid: process.pid });
  cleanup();
  process.exit(0);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    log.info('main', `signal ${sig}, closing browser`, {});
    cleanup();
    await session.context.close().catch(() => {});
    process.exit(0);
  });
}

// Держать процесс живым, пока браузер открыт.
await new Promise(() => {});
