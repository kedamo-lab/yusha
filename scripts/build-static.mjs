import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = resolve(root, 'public');
if (dirname(output) !== root || basename(output) !== 'public') throw new Error('Invalid build path');
await rm(output, { recursive: true, force: true });
await mkdir(output);
const files = ['index.html', 'clips.html', 'clips.css', 'clips.js', 'privacy.html', 'terms.html', 'legal.css', 'tiktok-config.js', 'tiktok-videos.json', 'page-transition.css', 'page-transition.js', 'favicon.png', 'hero.png', 'hero2.png', 'mockup.jpg'];
await Promise.all(files.map(file => copyFile(resolve(root, file), resolve(output, file))));
console.log(`Static build: ${files.length} public files.`);
