#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@agent-vision/core";
import { detectCapturer } from "./backends/index.js";
import { configPath, defaultStateDir, loadConfig, saveConfig, LocalConfig } from "./config.js";
import { ConsentStore } from "./consent.js";
import { createLocalServer } from "./http.js";
import { CaptureService } from "./service.js";
import { NotifyIndicator, SystemPrompter } from "./ui.js";

const [, , cmd = "help", ...rest] = process.argv;

function flag(name: string, def?: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : def;
}
const has = (name: string) => rest.includes(`--${name}`);

const stateDir = defaultStateDir();
const HELP = `agent-vision-local — service de capture local (consentement explicite, aucune prise de contrôle)

  init [--device-id ID] [--host H] [--port P] [--tls]   crée la config et affiche le jeton d'appareil (une seule fois)
  start                                                 démarre le service
  grant --agent ID [--minutes 30] [--targets screen,window]   autorise un agent (action locale uniquement)
  grant-observation --agent ID [--minutes 15] [--max-captures 60] [--min-interval-ms 5000]   autorise une session d'observation périodique bornée
  revoke [--agent ID]                                   révoque captures ET observations d'un agent (ou de tous)
  stop                                                  ARRÊT IMMÉDIAT : toute capture est refusée
  resume                                                lève l'arrêt (action locale uniquement)
  status                                                état, consentements actifs
  gen-cert                                              certificat TLS auto-signé (nécessite openssl)
`;

async function main(): Promise<void> {
  switch (cmd) {
    case "init": {
      if (existsSync(configPath(stateDir)) && !has("force")) throw new Error(`already initialised (${configPath(stateDir)}); use --force`);
      const token = randomBytes(32).toString("base64url");
      let tls: LocalConfig["tls"];
      if (has("tls")) tls = genCert();
      const cfg = LocalConfig.parse({
        deviceId: flag("device-id", `${process.platform}-${randomBytes(3).toString("hex")}`),
        tokenSha256: sha256Hex(token),
        host: flag("host", "127.0.0.1"),
        port: Number(flag("port", "7821")),
        tls,
      });
      saveConfig(stateDir, cfg);
      console.log(`Config : ${configPath(stateDir)}\nDevice : ${cfg.deviceId}\nJeton d'appareil (à copier dans la config du serveur MCP, non récupérable) :\n\n${token}\n`);
      if (tls) console.log(`Empreinte TLS SHA-256 (à épingler côté serveur) : ${certFingerprint(tls.certFile)}`);
      return;
    }
    case "gen-cert": {
      const t = genCert();
      console.log(`cert=${t.certFile}\nkey=${t.keyFile}\nfingerprint256=${certFingerprint(t.certFile)}`);
      return;
    }
    case "grant": {
      const agent = flag("agent");
      if (!agent) throw new Error("--agent required");
      const targets = (flag("targets", "screen,window") as string).split(",") as ("screen" | "window")[];
      const g = new ConsentStore(stateDir).grant(agent, Number(flag("minutes", "30")), targets);
      console.log(`Consentement accordé à "${agent}" (${targets.join(",")}) jusqu'à ${g.expiresAt}`);
      return;
    }
    case "grant-observation": {
      const agent = flag("agent");
      if (!agent) throw new Error("--agent required");
      const g = new ConsentStore(stateDir).grantObservation(agent, Number(flag("minutes", "15")), Number(flag("max-captures", "60")), Number(flag("min-interval-ms", "5000")));
      console.log(`Observation autorisée pour "${agent}" jusqu'à ${g.expiresAt} (≤ ${g.maxCaptures} captures, intervalle ≥ ${g.minIntervalMs} ms). Arrêt immédiat : \`stop\` ou \`revoke\`.`);
      return;
    }
    case "revoke":
      console.log(`${new ConsentStore(stateDir).revoke(flag("agent"))} consentement(s) révoqué(s)`);
      return;
    case "stop":
      new ConsentStore(stateDir).stop();
      console.log("ARRÊT : plus aucune capture ne sera effectuée jusqu'à `resume`.");
      return;
    case "resume":
      new ConsentStore(stateDir).resume();
      console.log("Captures de nouveau possibles (selon les consentements).");
      return;
    case "status": {
      const c = new ConsentStore(stateDir);
      const cfg = loadConfig(stateDir);
      console.log(JSON.stringify({ deviceId: cfg.deviceId, listen: `${cfg.host}:${cfg.port}`, tls: !!cfg.tls, consentMode: cfg.consentMode, stopped: c.isStopped(), grants: c.list() }, null, 2));
      return;
    }
    case "start": {
      const config = loadConfig(stateDir);
      const capturer = await detectCapturer();
      if (!capturer) throw new Error("no capture backend available on this system");
      const consent = new ConsentStore(stateDir);
      const service = new CaptureService({
        config, consent, capturer, stateDir,
        prompter: new SystemPrompter(),
        indicator: new NotifyIndicator(config.notify),
      });
      const server = createLocalServer({ config, service, consent, backendName: capturer.name, capturer });
      server.listen(config.port, config.host, () =>
        console.error(`[agent-vision] ${config.tls ? "https" : "http"}://${config.host}:${config.port} — backend ${capturer.name} — consentMode ${config.consentMode}`),
      );
      const shutdown = () => server.close(() => process.exit(0));
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    default:
      console.log(HELP);
  }
}

function genCert(): { certFile: string; keyFile: string } {
  const dir = join(stateDir, "tls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "825", "-subj", "/CN=agent-vision-local", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  return { certFile, keyFile };
}

function certFingerprint(certFile: string): string {
  const out = execFileSync("openssl", ["x509", "-in", certFile, "-noout", "-fingerprint", "-sha256"]).toString();
  return out.split("=")[1]!.trim().replace(/:/g, "").toLowerCase();
}

main().catch((e: Error) => {
  console.error(`erreur : ${e.message}`);
  process.exit(1);
});
