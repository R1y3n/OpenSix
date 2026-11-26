// Small stroke icons, built as DOM nodes so the strict content security policy is never involved.
const paths = {
  dir: ['M3 6.5h6l2 2.2h10V19H3z'],
  folder: ['M3 6.5h6l2 2.2h10V19H3z'],
  archive: ['M4 4.5h16v4.5H4z', 'M5.5 9v10.5h13V9', 'M10 13h4'],
  model: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
  texture: ['M3.5 5h17v14h-17z', 'M3.5 16l5-5 4 4 3-3 5 5', 'M15.5 9.2h.01'],
  animation: ['M6 4.5v15l13-7.5z'],
  collision: ['M12 3l8 3v6c0 5-3.6 8-8 9-4.400-1-8-4-8-9V6z'],
  map: ['M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z', 'M9 4v14', 'M15 6v14'],
  audio: ['M9 18V5.500l11-2V16', 'M9 18a3 2.700 0 11-6 0 3 2.700 0 016 0z', 'M20 16a3 2.700 0 11-6 0 3 2.700 0 016 0z'],
  video: ['M3 6h12v12H3z', 'M15 10.500l6-3.500v10l-6-3.500'],
  data: ['M8 4C5 4 5 6 5 8s-1 3-2 4c1 1 2 2 2 4s0 4 3 4', 'M16 4c3 0 3 2 3 4s1 3 2 4c-1 1-2 2-2 4s0 4-3 4'],
  other: ['M6 3.500h8l4 4V20.500H6z', 'M14 3.500v4h4'],
  file: ['M6 3.500h8l4 4V20.500H6z', 'M14 3.500v4h4'],
  hash: ['M9.500 3L7.500 21', 'M16.500 3l-2 18', 'M4 9h17', 'M3 15h17'],
};

const namespace = 'http://www.w3.org/2000/svg';

export function icon(category) {
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.cat = paths[category] ? category : 'other';
  for (const d of paths[category] ?? paths.other) {
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function size(value) {
  if (value === null || value === undefined) return '';
  if (value < 1024) return value.toLocaleString() + ' B';
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + ' KiB';
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + ' MiB';
  return (value / 1024 ** 3).toFixed(2) + ' GiB';
}

export const hex = value => '0x' + value.toString(16).toUpperCase();
