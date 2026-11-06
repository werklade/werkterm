export function formatSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const unit = size === 0 ? 0 : Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** unit).toFixed(1)} ${units[unit]}`;
}
