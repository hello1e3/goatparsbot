export const PLATFORMS = {
  windows: { label: 'Windows', extension: '.exe', hint: 'Запустите установщик и следуйте подсказкам.' },
  mac_arm64: { label: 'macOS — Apple Silicon (M1 и новее)', extension: '.dmg', hint: 'Откройте DMG и перетащите GOAT Parser в «Программы».' },
  mac_x64: { label: 'macOS — Intel', extension: '.dmg', hint: 'Откройте DMG и перетащите GOAT Parser в «Программы».' },
};
export const validPlatform = (key) => Object.hasOwn(PLATFORMS, key);
export function migrateFiles(db, env = {}) {
  db.files ??= {};
  if (!db.files.windows && (db.fileId || env.FILE_ID || env.DOWNLOAD_URL)) {
    db.files.windows = { fileId: db.fileId || env.FILE_ID || null, fileName: db.fileName || null, url: env.DOWNLOAD_URL || '' };
  }
  for (const key of Object.keys(PLATFORMS)) {
    const id = env[`FILE_ID_${key.toUpperCase()}`];
    if (!db.files[key] && id) db.files[key] = { fileId: id };
  }
}
export function availableFile(db, platform) {
  if (!validPlatform(platform)) return null;
  const file = db.files[platform];
  return file?.fileId || file?.url ? file : null;
}
