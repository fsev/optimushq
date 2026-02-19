import Docker from 'dockerode';
import { PassThrough } from 'stream';
import { getDb } from '../db/connection.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export interface DockerSpawnResult {
  stdout: PassThrough;
  stderr: PassThrough;
  /** Kill the current exec (not the container) */
  kill: () => Promise<void>;
  /** Container ID */
  containerId: string;
  /** True if an existing container was reused (CC session data persists) */
  containerReused: boolean;
}

/**
 * Translate a container-local project path (/projects/...) to the host path
 * using HOST_PROJECTS_DIR env var.
 */
function toHostPath(containerProjectPath: string): string {
  const relative = containerProjectPath.replace(/^\/projects\/?/, '');
  return `${process.env.HOST_PROJECTS_DIR}/${relative}`;
}

// ---- Resource limit helpers ------------------------------------------------

function parseMemoryLimit(): number {
  const raw = process.env.AGENT_MEMORY_LIMIT;
  if (!raw) return 4 * 1024 * 1024 * 1024; // 4 GB default
  const num = parseInt(raw, 10);
  return isNaN(num) ? 4 * 1024 * 1024 * 1024 : num;
}

function parseCpuLimit(): { CpuQuota: number; CpuPeriod: number } {
  const raw = process.env.AGENT_CPU_LIMIT;
  const cpus = raw ? parseFloat(raw) : 2;
  const period = 100_000;
  return { CpuQuota: Math.round((isNaN(cpus) ? 2 : cpus) * period), CpuPeriod: period };
}

function parsePidsLimit(): number {
  const raw = process.env.AGENT_PIDS_LIMIT;
  if (!raw) return 512;
  const num = parseInt(raw, 10);
  return isNaN(num) ? 512 : num;
}

// ---- Docker socket / runtime helpers ---------------------------------------

function shouldMountDockerSocket(): boolean {
  return process.env.AGENT_DOCKER_ACCESS === 'socket';
}

function getRuntime(): string | undefined {
  return process.env.AGENT_RUNTIME || undefined;
}

// ---- Persistent container management ---------------------------------------

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PersistentContainer {
  container: Docker.Container;
  containerName: string;
  idleTimer: ReturnType<typeof setTimeout>;
}

/** Persistent containers keyed by sessionId */
const persistentContainers = new Map<string, PersistentContainer>();

function resetIdleTimer(sessionId: string) {
  const entry = persistentContainers.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => despawnAgentContainer(sessionId), IDLE_TIMEOUT_MS);
}

/**
 * Stop and remove a session's persistent container.
 * Called on idle timeout, session done/delete, or server cleanup.
 */
export async function despawnAgentContainer(sessionId: string): Promise<void> {
  const entry = persistentContainers.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  persistentContainers.delete(sessionId);

  // Clear CC session ID — the session data is lost when the container goes away
  try {
    getDb().prepare("UPDATE sessions SET cc_session_id = NULL WHERE id = ?").run(sessionId);
  } catch {
    // DB may not be available during shutdown
  }

  try {
    await entry.container.stop({ t: 5 }).catch(() => {});
    await entry.container.remove({ force: true }).catch(() => {});
    console.log(`[DOCKER-SPAWN] Despawned container ${entry.containerName}`);
  } catch {
    // Already gone
  }
}

// ---- Main spawn function ---------------------------------------------------

/**
 * Ensure a persistent container exists for the session, then exec the claude
 * command inside it. The container stays alive between messages and is
 * despawned after IDLE_TIMEOUT_MS of inactivity.
 */
export async function spawnDockerAgent(
  sessionId: string,
  args: string[],
  opts: {
    projectPath?: string | null;
    agentImage?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<DockerSpawnResult> {
  const image = opts.agentImage
    || process.env.AGENT_DEFAULT_IMAGE
    || 'claude-agent-base';

  const containerName = `claude-agent-${sessionId}`;

  // Reuse existing container or create a new one
  let entry = persistentContainers.get(sessionId);

  if (entry) {
    // Verify container is still running
    try {
      const info = await entry.container.inspect();
      if (!info.State.Running) {
        // Container died — remove tracking and recreate
        clearTimeout(entry.idleTimer);
        persistentContainers.delete(sessionId);
        await entry.container.remove({ force: true }).catch(() => {});
        entry = undefined;
      }
    } catch {
      if (entry) {
        clearTimeout(entry.idleTimer);
        persistentContainers.delete(sessionId);
        entry = undefined;
      }
    }
  }

  let containerReused = false;
  if (!entry) {
    // Create a new persistent container
    const container = await createPersistentContainer(sessionId, containerName, image, opts);
    const idleTimer = setTimeout(() => despawnAgentContainer(sessionId), IDLE_TIMEOUT_MS);
    entry = { container, containerName, idleTimer };
    persistentContainers.set(sessionId, entry);
    console.log(`[DOCKER-SPAWN] Container started: ${entry.container.id}`);
  } else {
    containerReused = true;
    console.log(`[DOCKER-SPAWN] Reusing container ${containerName}`);
    resetIdleTimer(sessionId);
  }

  // Build per-exec env vars (MCP config may change between messages)
  const execEnv: string[] = [];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined) execEnv.push(`${k}=${v}`);
    }
  }

  // Exec claude command inside the persistent container
  // Write MCP proxy/config files then run claude, same as before
  const execCmd = [
    'sh', '-c',
    'printf \'%s\\n\' "$MCP_PROXY_SCRIPT" > /tmp/mcp-proxy.js && ' +
    'printf \'%s\\n\' "$MCP_CONFIG" > /tmp/mcp-config.json && ' +
    'exec claude "$@"',
    '--', ...args,
  ];

  const exec = await entry.container.exec({
    Cmd: execCmd,
    Env: execEnv,
    AttachStdout: true,
    AttachStderr: true,
  });

  const execStream = await exec.start({ hijack: true, stdin: false });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  docker.modem.demuxStream(execStream, stdout, stderr);

  // When the exec stream ends, close our passthrough streams
  execStream.on('end', () => {
    stdout.end();
    stderr.end();
    resetIdleTimer(sessionId);
  });
  execStream.on('error', () => {
    stdout.end();
    stderr.end();
  });

  // Get the exec PID so we can kill just this process (not the container)
  let execPid: number | null = null;
  try {
    const inspectInfo = await exec.inspect();
    execPid = inspectInfo.Pid || null;
  } catch {
    // Best effort
  }

  return {
    stdout,
    stderr,
    containerId: entry.container.id,
    containerReused,
    kill: async () => {
      // Kill just the exec process, not the container
      if (execPid && entry) {
        try {
          console.log(`[DOCKER-SPAWN] Killing exec pid=${execPid} in ${containerName}`);
          const killExec = await entry.container.exec({
            Cmd: ['kill', '-TERM', String(execPid)],
          });
          await killExec.start({ hijack: true, stdin: false });
        } catch (err: any) {
          if (!err.message?.includes('No such container')) {
            console.error(`[DOCKER-SPAWN] Exec kill error:`, err.message);
          }
        }
      }
    },
  };
}

// ---- Container creation helper ---------------------------------------------

async function createPersistentContainer(
  sessionId: string,
  containerName: string,
  image: string,
  opts: {
    projectPath?: string | null;
    env?: Record<string, string | undefined>;
  },
): Promise<Docker.Container> {
  // Build binds using HOST paths (critical for sibling container pattern)
  const hostProjectDir = opts.projectPath ? toHostPath(opts.projectPath) : null;
  const binds: string[] = [];

  if (shouldMountDockerSocket()) {
    binds.push('/var/run/docker.sock:/var/run/docker.sock');
  }
  if (hostProjectDir) {
    binds.push(`${hostProjectDir}:/workspace`);
  }

  // Credential mounts
  if (process.env.HOST_CLAUDE_DIR) {
    binds.push(`${process.env.HOST_CLAUDE_DIR}/.credentials.json:/home/node/.claude/.credentials.json:ro`);
  }
  if (process.env.HOST_CLAUDE_JSON) {
    binds.push(`${process.env.HOST_CLAUDE_JSON}:/home/node/.claude.json:ro`);
  }
  if (process.env.HOST_GH_DIR) {
    binds.push(`${process.env.HOST_GH_DIR}:/home/node/.config/gh:ro`);
  }
  if (process.env.HOST_AWS_DIR) {
    binds.push(`${process.env.HOST_AWS_DIR}:/home/node/.aws:ro`);
  }
  if (process.env.HOST_GITCONFIG) {
    binds.push(`${process.env.HOST_GITCONFIG}:/home/node/.gitconfig:ro`);
  }

  // Container-level env vars (stable across messages)
  const containerEnv: string[] = [
    `HOME=/home/node`,
    `GIT_AUTHOR_NAME=${process.env.GIT_AUTHOR_NAME || ''}`,
    `GIT_AUTHOR_EMAIL=${process.env.GIT_AUTHOR_EMAIL || ''}`,
    `GIT_COMMITTER_NAME=${process.env.GIT_COMMITTER_NAME || ''}`,
    `GIT_COMMITTER_EMAIL=${process.env.GIT_COMMITTER_EMAIL || ''}`,
  ];

  const dockerGid = process.env.DOCKER_GID;
  const groupAdd = (shouldMountDockerSocket() && dockerGid) ? [dockerGid] : [];

  // Ensure network exists
  const NETWORK_NAME = 'optimushq-net';
  try {
    const nets = await docker.listNetworks({ filters: JSON.stringify({ name: [NETWORK_NAME] }) });
    if (!nets.find(n => n.Name === NETWORK_NAME)) {
      await docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge' });
      console.log(`[DOCKER-SPAWN] Created network ${NETWORK_NAME}`);
    }
  } catch (err: any) {
    console.error(`[DOCKER-SPAWN] Network check/create failed:`, err.message);
  }

  const memoryLimit = parseMemoryLimit();
  const { CpuQuota, CpuPeriod } = parseCpuLimit();
  const pidsLimit = parsePidsLimit();
  const runtime = getRuntime();

  console.log(`[DOCKER-SPAWN] Creating container ${containerName} from image ${image}`);
  console.log(`[DOCKER-SPAWN] Binds: ${binds.join(', ')}`);
  console.log(`[DOCKER-SPAWN] Limits: mem=${memoryLimit}, cpuQuota=${CpuQuota}, pids=${pidsLimit}, runtime=${runtime || 'default'}`);
  console.log(`[DOCKER-SPAWN] Docker socket: ${shouldMountDockerSocket() ? 'yes' : 'no'}`);

  // Remove any leftover container with the same name
  try {
    const old = docker.getContainer(containerName);
    const info = await old.inspect().catch(() => null);
    if (info) {
      await old.stop({ t: 2 }).catch(() => {});
      await old.remove({ force: true }).catch(() => {});
    }
  } catch {
    // Container doesn't exist — expected
  }

  const container = await docker.createContainer({
    name: containerName,
    Image: image,
    Cmd: ['sleep', 'infinity'],
    WorkingDir: '/workspace',
    Env: containerEnv,
    OpenStdin: false,
    Tty: false,
    NetworkingConfig: {
      EndpointsConfig: {
        [NETWORK_NAME]: {},
      },
    },
    HostConfig: {
      Binds: binds,
      AutoRemove: false,
      GroupAdd: groupAdd,
      NetworkMode: NETWORK_NAME,
      Init: true,
      Memory: memoryLimit,
      CpuQuota,
      CpuPeriod,
      PidsLimit: pidsLimit,
      ...(runtime ? { Runtime: runtime } : {}),
    },
  });

  console.log(`[DOCKER-SPAWN] Container created: ${container.id}`);
  await container.start();

  // Watch for unexpected container death
  container.wait().then((result) => {
    console.log(`[DOCKER-SPAWN] Container ${containerName} exited unexpectedly with code ${result.StatusCode}`);
    const entry = persistentContainers.get(sessionId);
    if (entry) {
      clearTimeout(entry.idleTimer);
      persistentContainers.delete(sessionId);
    }
  }).catch(() => {});

  return container;
}

// ---- Health check -----------------------------------------------------------

export interface DockerHealthStatus {
  socketConnected: boolean;
  imageAvailable: boolean;
  imageName: string;
  networkExists: boolean;
  error: string | null;
}

export async function checkDockerHealth(): Promise<DockerHealthStatus> {
  const imageName = process.env.AGENT_DEFAULT_IMAGE || 'claude-agent-base';
  const status: DockerHealthStatus = {
    socketConnected: false,
    imageAvailable: false,
    imageName,
    networkExists: false,
    error: null,
  };

  try {
    await docker.ping();
    status.socketConnected = true;
  } catch (err: any) {
    status.error = `Docker socket not accessible: ${err.message}\n` +
      'Remediation: Ensure Docker is running and /var/run/docker.sock is mounted.\n' +
      'If running locally, start Docker Desktop or the Docker daemon.\n' +
      'If running in a container, mount -v /var/run/docker.sock:/var/run/docker.sock';
    return status;
  }

  try {
    await docker.getImage(imageName).inspect();
    status.imageAvailable = true;
  } catch (err: any) {
    status.error = `Agent image "${imageName}" not found: ${err.message}\n` +
      'Remediation: Build the agent image first:\n' +
      '  docker compose build claude-agent-base\n' +
      'Or build directly:\n' +
      `  docker build -t ${imageName} -f docker/agent/base/Dockerfile .`;
    return status;
  }

  try {
    const nets = await docker.listNetworks({ filters: JSON.stringify({ name: ['optimushq-net'] }) });
    status.networkExists = nets.some(n => n.Name === 'optimushq-net');
    if (!status.networkExists) {
      status.error = 'Docker network "optimushq-net" not found. It will be created automatically on first agent spawn.';
    }
  } catch (err: any) {
    status.error = `Failed to check Docker networks: ${err.message}`;
  }

  return status;
}

export async function validateImageExists(imageName: string): Promise<boolean> {
  try {
    await docker.getImage(imageName).inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up orphaned agent containers from previous runs.
 * Call this on server startup.
 */
export async function cleanupOrphanedAgents(): Promise<void> {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ name: ['claude-agent-'] }),
    });

    for (const c of containers) {
      try {
        const container = docker.getContainer(c.Id);
        await container.stop({ t: 2 }).catch(() => {});
        await container.remove({ force: true }).catch(() => {});
      } catch {
        // Already gone
      }
    }

    if (containers.length > 0) {
      console.log(`[DOCKER-SPAWN] Cleaned up ${containers.length} orphaned agent container(s)`);
    }
  } catch (err: any) {
    console.error(`[DOCKER-SPAWN] Cleanup error:`, err.message);
  }
}
