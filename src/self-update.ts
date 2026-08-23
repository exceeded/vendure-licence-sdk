/**
 * In-app self-update — lets a store admin update a HULO plugin from the
 * Vendure admin UI without touching a terminal. Explicitly requested and
 * approved by the product owner for the HULO plugin suite.
 *
 * What it does: runs the host project's own package manager
 * (`yarn add` / `npm install` / `pnpm add`) for THIS plugin at a
 * registry-verified version, confirms the new version landed on disk,
 * and then — only when a supervisor is detected that will bring the
 * process back up — schedules a graceful `process.exit(0)` so the
 * server restarts on the new code.
 *
 * Safety rails:
 *  - Callers hard-code the package name; it can never come from a
 *    request. Only HULO's own plugins use this module.
 *  - The endpoint that calls this is admin-authenticated (write
 *    permission) in every plugin.
 *  - The target version must exist on the npm registry (checked first).
 *  - The process only exits when a supervisor is detected (pm2 or
 *    systemd), or when the operator explicitly forces it with
 *    HULO_SELF_UPDATE=force. Otherwise we install and tell the admin a
 *    manual restart is needed.
 *  - HULO_SELF_UPDATE=off disables the whole feature.
 *  - Install output is captured and returned for debugging; a failed
 *    install never restarts anything.
 *  - Concurrency guard: one update at a time per process.
 *
 * Honest limitation: the ADMIN UI bundle is compiled by the host's
 * build pipeline. After a self-update the server-side plugin code is
 * new immediately; the admin UI refreshes the next time the host
 * compiles its admin UI (setups using `compileUiExtensions` at startup
 * pick it up on the restart).
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@vendure/core';

const loggerCtx = 'HuloSelfUpdate';

export interface SelfUpdateEnv {
    /** Feature switch: HULO_SELF_UPDATE=off disables. */
    allowed: boolean;
    /** Detected from the host project's lockfile. */
    packageManager: 'yarn' | 'pnpm' | 'npm' | null;
    /** True when something will restart the process after exit(0). */
    supervised: boolean;
    reason?: string;
}

export interface SelfUpdateResult {
    ok: boolean;
    message: string;
    installedVersion?: string;
    restartScheduled: boolean;
    log?: string;
}

let updateInFlight = false;

export function selfUpdateEnv(): SelfUpdateEnv {
    if (String(process.env.HULO_SELF_UPDATE || '').toLowerCase() === 'off') {
        return { allowed: false, packageManager: null, supervised: false, reason: 'Disabled via HULO_SELF_UPDATE=off' };
    }
    const root = process.cwd();
    let pm: SelfUpdateEnv['packageManager'] = null;
    if (existsSync(join(root, 'yarn.lock'))) pm = 'yarn';
    else if (existsSync(join(root, 'pnpm-lock.yaml'))) pm = 'pnpm';
    else if (existsSync(join(root, 'package-lock.json'))) pm = 'npm';
    else if (existsSync(join(root, 'package.json'))) pm = 'npm';
    if (!pm) {
        return { allowed: false, packageManager: null, supervised: false, reason: 'No package.json found in the working directory' };
    }
    const forced = String(process.env.HULO_SELF_UPDATE || '').toLowerCase() === 'force';
    const pm2 = !!(process.env.PM2_HOME || process.env.pm_id !== undefined);
    const systemd = !!process.env.INVOCATION_ID;
    const supervised = forced || pm2 || systemd;
    return {
        allowed: true,
        packageManager: pm,
        supervised,
        reason: supervised ? undefined : 'No process supervisor detected — the server must be restarted manually after installing',
    };
}

/** Does `packageName@version` exist on the public registry? */
async function versionExists(packageName: string, version: string): Promise<boolean> {
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 10_000);
        const resp = await fetch(
            `https://registry.npmjs.org/${packageName.replace('/', '%2F')}/${encodeURIComponent(version)}`,
            { signal: controller.signal },
        );
        clearTimeout(t);
        return !!resp && resp.ok;
    } catch {
        return false;
    }
}

function installedVersionOf(packageName: string): string | null {
    try {
        // Read from disk every time — the require cache holds the old build.
        const p = join(process.cwd(), 'node_modules', ...packageName.split('/'), 'package.json');
        return JSON.parse(readFileSync(p, 'utf8')).version || null;
    } catch {
        return null;
    }
}

export async function performSelfUpdate(opts: {
    /** Hard-coded by the calling plugin — never request-derived. */
    packageName: string;
    targetVersion: string;
    /** Kill the install after this long. Default 5 minutes. */
    timeoutMs?: number;
}): Promise<SelfUpdateResult> {
    if (!opts.packageName.startsWith('@huloglobal/')) {
        return { ok: false, message: 'Self-update only handles HULO plugins', restartScheduled: false };
    }
    const env = selfUpdateEnv();
    if (!env.allowed || !env.packageManager) {
        return { ok: false, message: env.reason || 'Self-update is not available in this environment', restartScheduled: false };
    }
    const version = String(opts.targetVersion || '').trim();
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
        return { ok: false, message: `"${version}" is not a valid version`, restartScheduled: false };
    }
    if (!(await versionExists(opts.packageName, version))) {
        return { ok: false, message: `${opts.packageName}@${version} was not found on the npm registry`, restartScheduled: false };
    }
    if (updateInFlight) {
        return { ok: false, message: 'Another update is already running — try again in a minute', restartScheduled: false };
    }
    updateInFlight = true;

    try {
        const spec = `${opts.packageName}@${version}`;
        const args = env.packageManager === 'yarn' ? ['add', spec, '--non-interactive']
            : env.packageManager === 'pnpm' ? ['add', spec]
            : ['install', spec, '--no-audit', '--no-fund'];

        Logger.warn(`Self-update requested: ${spec} via ${env.packageManager}`, loggerCtx);
        const result = await new Promise<{ code: number | null; out: string }>(resolve => {
            const child = spawn(env.packageManager!, args, { cwd: process.cwd(), env: process.env, shell: false });
            let out = '';
            const cap = (d: Buffer) => { out += d.toString(); if (out.length > 20_000) out = out.slice(-20_000); };
            child.stdout?.on('data', cap);
            child.stderr?.on('data', cap);
            const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, opts.timeoutMs ?? 5 * 60_000);
            child.on('close', code => { clearTimeout(t); resolve({ code, out }); });
            child.on('error', e => { clearTimeout(t); resolve({ code: -1, out: out + '\n' + e.message }); });
        });

        const nowInstalled = installedVersionOf(opts.packageName);
        if (result.code !== 0 || nowInstalled !== version) {
            Logger.error(`Self-update failed for ${spec}: exit=${result.code}, on disk=${nowInstalled}`, loggerCtx);
            return {
                ok: false,
                message: `Install failed (exit ${result.code}); ${opts.packageName} on disk is ${nowInstalled || 'unknown'}. Nothing was restarted.`,
                installedVersion: nowInstalled || undefined,
                restartScheduled: false,
                log: result.out.slice(-4_000),
            };
        }

        if (env.supervised) {
            Logger.warn(`Self-update installed ${spec} — restarting in 2s (supervisor detected)`, loggerCtx);
            setTimeout(() => process.exit(0), 2_000).unref();
            return {
                ok: true,
                message: `Updated to ${version}. The server is restarting now — this page will reconnect in a few seconds. (A separate worker process picks the update up on its next restart; the admin UI refreshes after your next admin build.)`,
                installedVersion: version,
                restartScheduled: true,
            };
        }
        return {
            ok: true,
            message: `Updated to ${version} on disk. Restart your Vendure server to load it (no supervisor was detected, so it was not restarted automatically).`,
            installedVersion: version,
            restartScheduled: false,
        };
    } finally {
        updateInFlight = false;
    }
}
