import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'dsh-package-check-'));

/** npm is a shell script on Windows, so run its JavaScript entry point with the current runtime. */
function pack(destination) {
  const cli = process.env.npm_execpath;
  const args = ['pack', '--json', '--silent', '--pack-destination', destination];
  if (cli && /\.(?:c|m)?js$/i.test(cli)) return execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  return execFileSync('npm', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
}

try {
  const report = JSON.parse(pack(scratch));
  const packed = Array.isArray(report) ? report : Object.values(report);
  if (packed.length !== 1 || !packed[0].filename) throw new Error('Expected one packed plugin archive');
  const modules = join(scratch, 'node_modules');
  const destination = join(modules, 'dsh-eu4-modding');
  await mkdir(destination, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', join(scratch, packed[0].filename), '--strip-components=1', '-C', destination], { stdio: 'inherit' });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Extracting the package requires tar (bsdtar ships with Windows 10+, macOS and Linux)');
    throw error;
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const link = join(modules, name);
    await mkdir(dirname(link), { recursive: true });
    // Directory junctions need no elevation on Windows, unlike symbolic links.
    await symlink(join(root, 'node_modules', name), link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const declaration = await readFile(join(destination, 'lib/config.d.ts'), 'utf8');
  if (/\.pnpm[\/\\]|import\(["']@deepseek-ai\/cosmokit/.test(declaration)) throw new Error('Config declarations leak a transitive dependency');
  await writeFile(join(scratch, 'consumer.mts'), `import { Config, type PluginConfig } from 'dsh-eu4-modding';
const dependency: PluginConfig['dependencies'][number] = { id: 'base', path: '../base' };
// @ts-expect-error A dependency id remains a string, not any.
const invalid: PluginConfig['dependencies'][number] = { id: 123, path: '../base' };
const parsed = Config({ dependencies: [dependency], vanillaMode: 'disabled' });
parsed.dependencies?.[0]?.id.toUpperCase();
void invalid;
`);
  await writeFile(join(scratch, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] }, include: ['consumer.mts'] }));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/lib/tsc.js'), '-p', join(scratch, 'tsconfig.json')], { stdio: 'inherit' });
  console.log('Packed entry point and consumer types verified.');
} finally { await rm(scratch, { recursive: true, force: true }); }
