
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync('icon.svg', 'utf8');
const sizeList = [16, 24, 32, 48, 64, 128, 256];
const centered = source
  .replace(/^<\?xml.*?\?>\s*/s, '')
  .replace(/<svg\b([^>]+)>/s, (_match, attrs) =>
    '<svg' + attrs.replace(/\s(?:width|height)="[^"]*"/g, '') +
      ' x="0" y="30.4" width="256" height="194.2">');
const square = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">' +
  centered + '</svg>';
const icons = sizeList.map(size => Buffer.from(new Resvg(square, {
  fitTo: { mode: 'width', value: size },
}).render().asPng()));
const directory = Buffer.alloc(6 + 16 * icons.length);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(icons.length, 4);
let position = directory.length;
for (let index = 0; index < icons.length; index++) {
  const size = sizeList[index];
  const p = 6 + index * 16;
  directory[p] = directory[p + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, p + 4);
  directory.writeUInt16LE(32, p + 6);
  directory.writeUInt32LE(icons[index].length, p + 8);
  directory.writeUInt32LE(position, p + 12);
  position += icons[index].length;
}
writeFileSync('assets/OpenSix.ico', Buffer.concat([directory, ...icons]));
writeFileSync('assets/window.png', icons.at(-1));
console.log('Windows icon sizes', sizeList.join(', '));
