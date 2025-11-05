export function formatNumber(value, { fallback = 'n/a', fractionDigits = 2 } = {}) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value.toFixed(fractionDigits);
}

export function formatHz(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  if (value >= 100) {
    return `${value.toFixed(0)} Hz`;
  }
  if (value >= 10) {
    return `${value.toFixed(1)} Hz`;
  }
  return `${value.toFixed(2)} Hz`;
}

export function formatBytesPerSecond(value, { suffix = 'B/s' } = {}) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let unitIndex = 0;
  let current = value;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = current >= 100 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let unitIndex = 0;
  let current = value;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = current >= 100 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}
