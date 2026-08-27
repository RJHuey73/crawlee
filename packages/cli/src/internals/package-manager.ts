import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Package managers the Crawlee CLI knows how to delegate to.
 */
export const PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm', 'bun'] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/**
 * Lockfiles in the order they are checked. `pnpm` and `yarn` come first, as those two often leave
 * a stale `package-lock.json` behind in projects migrated away from npm.
 */
const LOCKFILES: readonly (readonly [file: string, packageManager: PackageManager])[] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
];

function isPackageManager(value: string): value is PackageManager {
    return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/**
 * Reads the corepack `packageManager` field (e.g. `"pnpm@8.6.0"`) from the `package.json` in the given
 * directory. Returns `undefined` when the file, the field or the package manager name are missing or unknown.
 */
function detectFromPackageJson(directory: string): PackageManager | undefined {
    const packageJsonPath = join(directory, 'package.json');

    if (!existsSync(packageJsonPath)) {
        return undefined;
    }

    try {
        const { packageManager } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

        if (typeof packageManager !== 'string') {
            return undefined;
        }

        // The field is `<name>@<version>`, optionally followed by a `+<hash>` integrity suffix.
        const name = packageManager.split('@')[0];

        return isPackageManager(name) ? name : undefined;
    } catch {
        // Unreadable or malformed `package.json`, fall back to the other detection methods.
        return undefined;
    }
}

function detectFromLockfile(directory: string): PackageManager | undefined {
    for (const [file, packageManager] of LOCKFILES) {
        if (existsSync(join(directory, file))) {
            return packageManager;
        }
    }

    return undefined;
}

/**
 * Parses the `npm_config_user_agent` variable every package manager sets for the processes it spawns,
 * e.g. `pnpm/8.6.0 npm/? node/v20.0.0 linux x64`.
 */
function detectFromUserAgent(userAgent?: string): PackageManager | undefined {
    if (!userAgent) {
        return undefined;
    }

    const name = userAgent.split('/')[0];

    return isPackageManager(name) ? name : undefined;
}

/**
 * Detects the package manager the current project uses, so the CLI can delegate to the same one instead of
 * always assuming npm.
 *
 * Starting at `cwd` and walking up towards the filesystem root, the first directory that declares a
 * `packageManager` field in its `package.json` or contains a known lockfile wins. If the walk finds nothing,
 * the package manager that spawned this process is used, and `npm` is the final fallback.
 */
export function detectPackageManager(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): PackageManager {
    for (let directory = cwd; ; ) {
        const declared = detectFromPackageJson(directory);

        if (declared) {
            return declared;
        }

        const fromLockfile = detectFromLockfile(directory);

        if (fromLockfile) {
            return fromLockfile;
        }

        const parent = dirname(directory);

        if (parent === directory) {
            break;
        }

        directory = parent;
    }

    return detectFromUserAgent(env.npm_config_user_agent) ?? 'npm';
}

/**
 * Builds the command that runs the given `package.json` script with the project's package manager.
 */
export function runScriptCommand(script: string, packageManager: PackageManager = detectPackageManager()): string {
    return `${packageManager} run ${script}`;
}

/**
 * Builds the command that executes a binary provided by one of the project's dependencies (e.g. `playwright`)
 * with the project's package manager.
 */
export function execBinaryCommand(command: string, packageManager: PackageManager = detectPackageManager()): string {
    switch (packageManager) {
        case 'pnpm':
            return `pnpm exec ${command}`;
        case 'yarn':
            // Works in both Yarn Classic and Yarn Berry, unlike `yarn dlx`/`yarn exec`, which differ between them.
            return `yarn ${command}`;
        case 'bun':
            return `bunx ${command}`;
        default:
            return `npx ${command}`;
    }
}
