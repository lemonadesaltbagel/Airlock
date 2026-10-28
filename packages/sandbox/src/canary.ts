import { LOOPBACK_VIA_PROXY_PREFIX } from "./srt.js";

/**
 * Egress canary: commands that try to get data out of, or reach past, the sandbox. Each probe is
 * run inside the sandbox and must fail (or, for the control probe, succeed). Used by the test
 * suite and by `airlock doctor`.
 */
export interface CanaryContext {
  /** Absolute path of the Node binary (readable inside the sandbox). */
  node: string;
  workspace: string;
  /** Gateway stand-in reachable through the proxy: http://127.0.0.1:<port>. */
  gatewayUrl: string;
  /** A TCP service on loopback that is NOT allowed. */
  localServicePort: number;
  /** A Unix socket some host daemon listens on. */
  unixSocketPath: string;
  /** A file in the home directory outside the workspace. */
  homeFile: string;
  /** A file in Airlock's private data directory. */
  privateFile: string;
  /** A path in the home directory that does not exist yet (writes there must fail). */
  homeWriteTarget: string;
  /** A path outside the workspace and the session tmp (writes there must fail). */
  outsideWriteTarget: string;
  /** Name of an environment variable set in the parent but not passed to the child. */
  parentSecretVar: string;
}

export interface CanaryProbe {
  id: string;
  what: string;
  /** "allowed" is a control: it proves the probe harness can tell success from failure. */
  expect: "blocked" | "allowed";
  platforms?: NodeJS.Platform[];
  command(ctx: CanaryContext): string;
}

export interface ProbeResult {
  code: number | null;
  output: string;
}

const MARK = "CANARY_REACHED";

function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function nodeEval(ctx: CanaryContext, code: string, prefix = ""): string {
  return `${prefix}${sh(ctx.node)} -e ${sh(code)}`;
}

/** A probe passes when the forbidden thing did not happen: its success marker is absent. */
export function probeReached(result: ProbeResult): boolean {
  return result.output.includes(MARK);
}

const fetchThenMark = (url: string) =>
  `fetch(${JSON.stringify(url)}).then(async r=>{const t=await r.text();if(!r.ok){console.log("failed",r.status,t.slice(0,80));process.exit(3)}console.log("${MARK}",t.slice(0,40))},e=>{console.log("failed",e.cause?.code??e.message);process.exit(3)})`;

export const CANARY_PROBES: CanaryProbe[] = [
  {
    id: "gateway-via-proxy",
    what: "the gateway is reachable through the sandbox proxy (control)",
    expect: "allowed",
    command: (c) => nodeEval(c, fetchThenMark(`${c.gatewayUrl}/canary`), LOOPBACK_VIA_PROXY_PREFIX),
  },
  {
    id: "gateway-direct",
    what: "connecting to loopback directly, bypassing the proxy",
    expect: "blocked",
    command: (c) => nodeEval(c, fetchThenMark(`${c.gatewayUrl}/canary`)),
  },
  {
    id: "https-direct",
    what: "HTTPS to a public IP without the proxy",
    expect: "blocked",
    command: () => `curl -sS -m 5 --noproxy '*' -k https://1.1.1.1 -o /dev/null && echo ${MARK}`,
  },
  {
    id: "https-unlisted-host",
    what: "HTTPS through the proxy to a host nobody allowed",
    expect: "blocked",
    command: () => `curl -sS -m 8 https://example.com -o /dev/null && echo ${MARK}`,
  },
  {
    id: "http-unlisted-host",
    what: "plain HTTP through the proxy to a host nobody allowed",
    expect: "blocked",
    command: () => `curl -sS -m 8 -f http://example.com -o /dev/null && echo ${MARK}`,
  },
  {
    id: "telemetry-hosts",
    what: "common telemetry endpoints (npm, Next.js, Sentry, Segment, PostHog)",
    expect: "blocked",
    command: () =>
      ["https://registry.npmjs.org/-/ping", "https://telemetry.nextjs.org/api/v1/record", "https://o0.ingest.sentry.io/api/0/envelope/", "https://api.segment.io/v1/batch", "https://us.i.posthog.com/batch/"]
        .map((u) => `curl -sS -m 8 -f ${u} -o /dev/null && echo ${MARK}`)
        .join("; "),
  },
  {
    id: "dns-udp",
    what: "a DNS query to a public resolver over UDP (DNS exfiltration)",
    expect: "blocked",
    command: (c) =>
      nodeEval(
        c,
        `const r=new (require("dns").Resolver)();r.setServers(["1.1.1.1"]);r.resolve4("example.com",(e,a)=>{if(e){console.log("failed",e.code);process.exit(3)}console.log("${MARK}",a)})`,
      ),
  },
  {
    id: "dns-system",
    what: "a DNS lookup through the system resolver",
    expect: "blocked",
    // example.com exists, so any error means the resolver could not be reached.
    command: (c) => nodeEval(c, `require("dns").lookup("example.com",(e,a)=>{if(e){console.log("failed",e.code);process.exit(3)}console.log("${MARK}",a)})`),
  },
  {
    id: "raw-tcp",
    what: "a raw TCP connection to a public IP",
    expect: "blocked",
    command: (c) => nodeEval(c, `const s=require("net").connect(443,"1.1.1.1",()=>{console.log("${MARK}");s.destroy()});s.on("error",e=>{console.log("failed",e.code);process.exit(3)});setTimeout(()=>process.exit(4),5000)`),
  },
  {
    id: "raw-udp",
    what: "a UDP datagram to a public IP",
    expect: "blocked",
    command: (c) => nodeEval(c, `const s=require("dgram").createSocket("udp4");s.send("x",53,"1.1.1.1",e=>{if(e){console.log("failed",e.code);process.exit(3)}console.log("${MARK}");s.close()})`),
  },
  {
    id: "ssh",
    what: "SSH to a code host (git push over ssh)",
    expect: "blocked",
    command: () => `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no -T git@github.com 2>&1 | grep -qi "successfully authenticated\\|permission denied (publickey)" && echo ${MARK}`,
  },
  {
    id: "localhost-service-direct",
    what: "a service on this machine's loopback (local model server, dev server, proxy)",
    expect: "blocked",
    command: (c) => nodeEval(c, `const s=require("net").connect(${c.localServicePort},"127.0.0.1",()=>{console.log("${MARK}");s.destroy()});s.on("error",e=>{console.log("failed",e.code);process.exit(3)})`),
  },
  {
    id: "localhost-service-via-proxy",
    what: "the same loopback service through the proxy",
    expect: "blocked",
    command: (c) => nodeEval(c, fetchThenMark(`http://127.0.0.1:${c.localServicePort}/`), LOOPBACK_VIA_PROXY_PREFIX),
  },
  {
    id: "unix-socket",
    what: "a host daemon's Unix socket (Docker, ssh-agent, gpg-agent)",
    expect: "blocked",
    command: (c) => nodeEval(c, `const s=require("net").connect(${JSON.stringify(c.unixSocketPath)},()=>{console.log("${MARK}");s.destroy()});s.on("error",e=>{console.log("failed",e.code);process.exit(3)})`),
  },
  {
    id: "read-home",
    what: "reading a file in the home directory outside the workspace",
    expect: "blocked",
    command: (c) => `cat ${sh(c.homeFile)} && echo ${MARK}`,
  },
  {
    id: "read-home-via-symlink",
    what: "reading that file through a symlink created in the workspace",
    expect: "blocked",
    command: (c) => `ln -sf ${sh(c.homeFile)} ${sh(c.workspace + "/canary-link")} && cat ${sh(c.workspace + "/canary-link")} && echo ${MARK}`,
  },
  {
    id: "read-ssh-keys",
    what: "listing ~/.ssh",
    expect: "blocked",
    command: () => `ls -a "$HOME/.ssh" >/dev/null && echo ${MARK}`,
  },
  {
    id: "read-airlock-data",
    what: "reading Airlock's own log and keys",
    expect: "blocked",
    command: (c) => `cat ${sh(c.privateFile)} && echo ${MARK}`,
  },
  {
    id: "write-home",
    what: "writing a file in the home directory (shell startup files, autostart)",
    expect: "blocked",
    command: (c) => `echo x > ${sh(c.homeWriteTarget)} && echo ${MARK}`,
  },
  {
    id: "write-outside",
    what: "writing outside the workspace and session scratch space",
    expect: "blocked",
    command: (c) => `echo x > ${sh(c.outsideWriteTarget)} && echo ${MARK}`,
  },
  {
    id: "write-git-hooks",
    what: "planting a git hook that runs later outside the sandbox",
    expect: "blocked",
    command: (c) => `echo 'exit 0' > ${sh(c.workspace + "/.git/hooks/pre-commit")} && echo ${MARK}`,
  },
  {
    id: "write-git-config",
    what: "changing .git/config (core.fsmonitor, hooksPath, aliases run outside the sandbox)",
    expect: "blocked",
    command: (c) => `echo '[core]' >> ${sh(c.workspace + "/.git/config")} && echo ${MARK}`,
  },
  {
    id: "write-husky-hook",
    what: "planting a husky hook (runs on the user's next commit)",
    expect: "blocked",
    command: (c) => `mkdir -p ${sh(c.workspace + "/.husky")} && echo 'exit 0' > ${sh(c.workspace + "/.husky/pre-commit")} && echo ${MARK}`,
  },
  {
    id: "write-envrc",
    what: "writing .envrc (direnv runs it when the user enters the directory)",
    expect: "blocked",
    command: (c) => `echo 'export X=1' > ${sh(c.workspace + "/.envrc")} && echo ${MARK}`,
  },
  {
    id: "write-nested-git-hook",
    what: "planting a hook in a nested repository",
    expect: "blocked",
    // bubblewrap protects only paths that exist when the sandbox starts; on Linux a repository
    // created during the session is caught by the post-session autorun check instead.
    platforms: ["darwin"],
    command: (c) => `mkdir -p ${sh(c.workspace + "/vendor/lib/.git/hooks")} 2>/dev/null; echo 'exit 0' > ${sh(c.workspace + "/vendor/lib/.git/hooks/post-checkout")} && echo ${MARK}`,
  },
  {
    id: "write-workspace",
    what: "ordinary writes inside the workspace work (control)",
    expect: "allowed",
    command: (c) => `echo ok > ${sh(c.workspace + "/src-file.txt")} && echo ${MARK}`,
  },
  {
    id: "write-airlock-policy",
    what: "changing the project's Airlock policy files",
    expect: "blocked",
    command: (c) => `echo '{}' > ${sh(c.workspace + "/.airlock/jewels.json")} && echo ${MARK}`,
  },
  {
    id: "apple-events",
    what: "scripting another app with Apple Events (runs outside the sandbox)",
    expect: "blocked",
    platforms: ["darwin"],
    command: () => `osascript -e 'tell application "System Events" to get name of first process' >/dev/null 2>&1 && echo ${MARK}`,
  },
  {
    id: "launch-app",
    what: "launching an app through Launch Services",
    expect: "blocked",
    platforms: ["darwin"],
    command: () => `open -g -j -a Calculator >/dev/null 2>&1 && echo ${MARK}`,
  },
  {
    id: "parent-env",
    what: "secrets in Airlock's own environment are not inherited",
    expect: "blocked",
    command: (c) => `test -n "$${c.parentSecretVar}" && echo ${MARK}`,
  },
];
