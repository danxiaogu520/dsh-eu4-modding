import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scratch = await mkdtemp(join(tmpdir(), 'dsh-package-check-'));
try {
  const report = JSON.parse(execFileSync('npm', ['pack', '--json', '--silent', '--pack-destination', scratch], { cwd: root, encoding: 'utf8' }));
  const packed = Array.isArray(report) ? report : Object.values(report);
  if (packed.length !== 1 || !packed[0].filename) throw new Error('Expected one packed plugin archive');
  const modules = join(scratch, 'node_modules');
  const destination = join(modules, 'dsh-eu4-modding');
  await mkdir(destination, { recursive: true });
  execFileSync('tar', ['-xzf', join(scratch, packed[0].filename), '--strip-components=1', '-C', destination]);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const link = join(modules, name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(root, 'node_modules', name), link, 'dir');
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
