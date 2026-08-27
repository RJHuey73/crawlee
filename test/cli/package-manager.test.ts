import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    detectPackageManager,
    execBinaryCommand,
    runScriptCommand,
} from '../../packages/cli/src/internals/package-manager';

/**
 * Creates an isolated project directory outside of the Crawlee repository, so the repository's own
 * `yarn.lock` cannot leak into the upwards walk performed by `detectPackageManager()`.
 */
function createProject(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'crawlee-package-manager-'));

    for (const [path, contents] of Object.entries(files)) {
        const fullPath = join(root, path);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, contents);
    }

    return root;
}

describe('detectPackageManager()', () => {
    describe('packageManager field', () => {
        test.each(['npm', 'yarn', 'pnpm', 'bun'] as const)('detects %s', (packageManager) => {
            const root = createProject({
                'package.json': JSON.stringify({ packageManager: `${packageManager}@1.2.3` }),
            });

            expect(detectPackageManager(root, {})).toBe(packageManager);
        });

        test('handles the corepack integrity hash suffix', () => {
            const root = createProject({
                'package.json': JSON.stringify({ packageManager: 'pnpm@8.6.0+sha224.abcdef' }),
            });

            expect(detectPackageManager(root, {})).toBe('pnpm');
        });

        test('takes precedence over a lockfile in the same directory', () => {
            const root = createProject({
                'package.json': JSON.stringify({ packageManager: 'pnpm@8.6.0' }),
                'package-lock.json': '{}',
            });

            expect(detectPackageManager(root, {})).toBe('pnpm');
        });

        test('an unknown package manager falls through to the lockfile', () => {
            const root = createProject({
                'package.json': JSON.stringify({ packageManager: 'cnpm@1.0.0' }),
                'pnpm-lock.yaml': '',
            });

            expect(detectPackageManager(root, {})).toBe('pnpm');
        });

        test('a malformed package.json does not throw', () => {
            const root = createProject({ 'package.json': '{ not json', 'yarn.lock': '' });

            expect(detectPackageManager(root, {})).toBe('yarn');
        });
    });

    describe('lockfiles', () => {
        test.each([
            ['pnpm-lock.yaml', 'pnpm'],
            ['yarn.lock', 'yarn'],
            ['bun.lockb', 'bun'],
            ['bun.lock', 'bun'],
            ['package-lock.json', 'npm'],
            ['npm-shrinkwrap.json', 'npm'],
        ] as const)('detects %s as %s', (lockfile, packageManager) => {
            const root = createProject({ 'package.json': '{}', [lockfile]: '' });

            expect(detectPackageManager(root, {})).toBe(packageManager);
        });

        test('prefers pnpm over a stale package-lock.json left behind by a migration', () => {
            const root = createProject({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'package-lock.json': '{}' });

            expect(detectPackageManager(root, {})).toBe('pnpm');
        });
    });

    describe('walking up the directory tree', () => {
        test('finds a lockfile in a parent directory', () => {
            const root = createProject({ 'package.json': '{}', 'pnpm-lock.yaml': '', 'src/nested/.keep': '' });

            expect(detectPackageManager(join(root, 'src', 'nested'), {})).toBe('pnpm');
        });

        test('the nearest declaration wins over the one further up', () => {
            const root = createProject({
                'package.json': JSON.stringify({ packageManager: 'pnpm@8.6.0' }),
                'packages/inner/package.json': JSON.stringify({ packageManager: 'bun@1.0.0' }),
            });

            expect(detectPackageManager(join(root, 'packages', 'inner'), {})).toBe('bun');
        });
    });

    describe('fallbacks', () => {
        test('uses the package manager that spawned the process when the project declares none', () => {
            const root = createProject({ 'src/.keep': '' });

            expect(
                detectPackageManager(root, { npm_config_user_agent: 'pnpm/8.6.0 npm/? node/v20.0.0 linux x64' }),
            ).toBe('pnpm');
        });

        test('a project declaration wins over the spawning package manager', () => {
            const root = createProject({ 'package.json': JSON.stringify({ packageManager: 'yarn@4.0.0' }) });

            expect(detectPackageManager(root, { npm_config_user_agent: 'pnpm/8.6.0 npm/? node/v20.0.0' })).toBe('yarn');
        });

        test('defaults to npm when there is nothing to go on', () => {
            const root = createProject({ 'src/.keep': '' });

            expect(detectPackageManager(root, {})).toBe('npm');
        });

        test('ignores an unrecognized user agent', () => {
            const root = createProject({ 'src/.keep': '' });

            expect(detectPackageManager(root, { npm_config_user_agent: 'cnpm/1.0.0 node/v20.0.0' })).toBe('npm');
        });
    });
});

describe('runScriptCommand()', () => {
    test.each([
        ['npm', 'npm run start'],
        ['yarn', 'yarn run start'],
        ['pnpm', 'pnpm run start'],
        ['bun', 'bun run start'],
    ] as const)('%s runs the script', (packageManager, expected) => {
        expect(runScriptCommand('start', packageManager)).toBe(expected);
    });

    test('passes the script name through', () => {
        expect(runScriptCommand('start:prod', 'pnpm')).toBe('pnpm run start:prod');
    });
});

describe('execBinaryCommand()', () => {
    test.each([
        ['npm', 'npx playwright install'],
        ['yarn', 'yarn playwright install'],
        ['pnpm', 'pnpm exec playwright install'],
        ['bun', 'bunx playwright install'],
    ] as const)('%s executes the binary', (packageManager, expected) => {
        expect(execBinaryCommand('playwright install', packageManager)).toBe(expected);
    });
});
