import { commandExists, defaultExec, type Exec } from "./exec.js";

/** Demande explicite à l'utilisateur local (mode `consentMode: "prompt"`). Refus par défaut. */
export interface Prompter {
  confirmCapture(agentId: string, target: string, reason?: string): Promise<boolean>;
}

/** Indicateur visible pendant une capture. */
export interface Indicator {
  begin(agentId: string, target: string, reason?: string): Promise<void>;
  end(): Promise<void>;
}

const sanitize = (s: string) => s.replace(/[^\p{L}\p{N} .,:;_()@/-]/gu, "?").slice(0, 200);

export class SystemPrompter implements Prompter {
  constructor(private readonly exec: Exec = defaultExec) {}

  async confirmCapture(agentId: string, target: string, reason?: string): Promise<boolean> {
    const text = `L'agent "${sanitize(agentId)}" demande une capture (${target}).${reason ? `\nMotif : ${sanitize(reason)}` : ""}\n\nAutoriser cette capture unique ?`;
    try {
      if (process.platform === "win32") {
        const ps = `Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show('${text.replace(/'/g, "''")}','Agent Vision','YesNo','Question'); if($r -eq 'Yes'){'yes'}else{'no'}`;
        const { stdout } = await this.exec("powershell.exe", ["-NoProfile", "-Command", ps], { timeoutMs: 120000 });
        return stdout.toString().trim() === "yes";
      }
      if (await commandExists(this.exec, "zenity")) {
        await this.exec("zenity", ["--question", "--title=Agent Vision", `--text=${text}`], { timeoutMs: 120000 });
        return true; // code de sortie 0
      }
      if (await commandExists(this.exec, "kdialog")) {
        await this.exec("kdialog", ["--title", "Agent Vision", "--yesno", text], { timeoutMs: 120000 });
        return true;
      }
    } catch {
      return false; // refus, annulation ou timeout
    }
    return false; // aucun moyen de demander → refus
  }
}

export class NotifyIndicator implements Indicator {
  constructor(private readonly enabled: boolean, private readonly exec: Exec = defaultExec, private readonly log: (m: string) => void = (m) => console.error(m)) {}

  async begin(agentId: string, target: string, reason?: string): Promise<void> {
    const msg = `Capture d'écran (${target}) pour l'agent "${sanitize(agentId)}"${reason ? ` — ${sanitize(reason)}` : ""}`;
    this.log(`[agent-vision] ${msg}`);
    if (!this.enabled) return;
    try {
      if (process.platform === "linux" && (await commandExists(this.exec, "notify-send"))) {
        await this.exec("notify-send", ["-a", "Agent Vision", "-i", "camera-photo", "Agent Vision", msg], { timeoutMs: 3000 });
      } else if (process.platform === "win32") {
        const ps = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(4000,'Agent Vision','${msg.replace(/'/g, "''")}','Info'); Start-Sleep -Milliseconds 800; $n.Dispose()`;
        await this.exec("powershell.exe", ["-NoProfile", "-Command", ps], { timeoutMs: 8000 });
      }
    } catch {
      /* l'indicateur est best-effort ; le log ci-dessus reste */
    }
  }

  async end(): Promise<void> {
    this.log("[agent-vision] capture terminée");
  }
}
