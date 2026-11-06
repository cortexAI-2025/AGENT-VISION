import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/** execFile sans shell (pas d'injection), sortie binaire, timeout. */
export const defaultExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "buffer", timeout: opts.timeoutMs ?? 15000, maxBuffer: 256 * 1024 * 1024, env: opts.env ?? process.env, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // message concis : jamais la ligne de commande complète (PowerShell encodé, chemins) ni le contenu de stdout
          const code = (err as NodeJS.ErrnoException & { killed?: boolean }).killed ? "timeout" : (err as NodeJS.ErrnoException).code;
          reject(Object.assign(new Error(`${cmd} failed (${code ?? "error"}): ${stderr.toString().trim().slice(0, 300)}`), { stderr: stderr.toString() }));
        }
        else resolve({ stdout, stderr: stderr.toString() });
      },
    );
  });

export async function commandExists(exec: Exec, cmd: string): Promise<boolean> {
  const probe = process.platform === "win32" ? ["where", [cmd]] : ["sh", ["-c", `command -v ${cmd}`]];
  try {
    await exec(probe[0] as string, probe[1] as string[], { timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}
