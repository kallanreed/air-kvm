// Builds the loadable extension into dist/.
//
// Chrome cannot resolve imports outside the extension directory, so shared/
// files are copied in. dist/ is the folder to load as an unpacked extension.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = resolve(fileURLToPath(import.meta.url), '..', '..');
const rootDir      = resolve(extensionDir, '..');
const srcDir       = join(extensionDir, 'src');
const sharedDir    = join(rootDir, 'shared');
const distDir      = join(extensionDir, 'dist');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Copy all JS and HTML source files into dist/, rewriting shared/ import paths
for (const file of readdirSync(srcDir)) {
  const ext = extname(file);
  if (ext === '.js' || ext === '.html') {
    let content = readFileSync(join(srcDir, file), 'utf8');
    // Rewrite shared/ relative imports to flat dist/ paths
    content = content.replaceAll("from '../../shared/binary_frame.js'", "from './binary_frame.js'");
    content = content.replaceAll("from '../../shared/halfpipe.js'",     "from './halfpipe.js'");
    writeFileSync(join(distDir, file), content);
  }
}

// Overwrite shim stubs with the real shared implementations
copyFileSync(join(sharedDir, 'binary_frame.js'), join(distDir, 'binary_frame.js'));
copyFileSync(join(sharedDir, 'halfpipe.js'),     join(distDir, 'halfpipe.js'));

// Write manifest.json verbatim — paths are already relative to dist/ root
const manifest = readFileSync(join(extensionDir, 'manifest.json'), 'utf8');
writeFileSync(join(distDir, 'manifest.json'), manifest);

console.log(`Extension built → ${distDir}`);
