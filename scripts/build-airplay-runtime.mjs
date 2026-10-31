import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runtimeRoot = resolve(process.env.AIRPLAY_BUILD_ROOT ?? join(root, '.context/airplay-runtime'));
const repository = 'https://github.com/Recluse/Popyachsa-AirPlay.git';
const revision = process.env.AIRPLAY_REVISION ?? '5497138ed8b2fb5106df1532d325e30f63baf9ed';
const source = join(runtimeRoot, 'Popyachsa-AirPlay');

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}
function requireCommand(command) {
  try { execFileSync(command, ['--version'], { stdio: 'ignore' }); }
  catch { throw new Error(`Missing required build tool: ${command}`); }
}

if (process.platform !== 'darwin') {
  throw new Error('The automated AirPlay runtime builder currently targets macOS. Windows uses the MSYS2 recipe in docs/AIRPLAY.md and will be added to the native package job.');
}
for (const command of ['git', 'cmake', 'ninja', 'cargo', 'brew']) requireCommand(command);
mkdirSync(runtimeRoot, { recursive: true });
if (!existsSync(source)) {
  run('git', ['clone', '--recurse-submodules', '--depth', '1', repository, source]);
}
run('git', ['fetch', '--depth', '1', 'origin', revision], { cwd: source });
run('git', ['checkout', '--detach', revision], { cwd: source });
run('brew', ['install', 'gstreamer', 'cmake', 'ninja', 'pkg-config']);
const engineBuild = join(source, 'third_party/uxplay/build');
run('cmake', ['-S', join(source, 'third_party/uxplay'), '-B', engineBuild, '-G', 'Ninja', '-DBUILD_CORE_DLL=ON', '-DNO_MARCH_NATIVE=ON']);
run('ninja', ['-C', engineBuild, 'uxplay-core']);
run('cargo', ['build', '--release'], { cwd: source });
run('bash', ['build/macos/make-app.sh'], { cwd: source });
const bundle = join(source, 'Popyachsa AirPlay.app');
if (!existsSync(bundle)) throw new Error(`Popyachsa build did not produce ${bundle}`);
console.log(JSON.stringify({ repository, revision, bundle }));
