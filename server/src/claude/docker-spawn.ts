import Docker from 'dockerode';
import { PassThrough } from 'stream';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export interface DockerSpawnResult {
  stdout: PassThrough;
  stderr: PassThrough;
  /** Stop and remove the container */
  kill: () => Promise<void>;
  /** Container ID */
  containerId: string;
}

/**
 * Translate a container-local project path (/projects/...) to the host path
 * using HOST_PROJECTS_DIR env var.
 */
function toHostPath(containerProjectPath: string): string {
  const relative = containerProjectPath.replace(/^\/projects\/?/, '');
  return `${process.env.HOST_PROJECTS_DIR}/${relative}`;
}

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
    || 'claude-agent-react';

  const containerName = `claude-agent-${sessionId}`;

  // Build binds using HOST paths (critical for sibling container pattern)
  const hostProjectDir = opts.projectPath ? toHostPath(opts.projectPath) : null;
  const binds: string[] = [
    '/var/run/docker.sock:/var/run/docker.sock',
  ];

  if (hostProjectDir) {
    binds.push(`${hostProjectDir}:/workspace`);
  }

  // Credential mounts from HOST paths
  if (process.env.HOST_CLAUDE_DIR) {
    binds.push(`${process.env.HOST_CLAUDE_DIR}:/home/node/.claude`);
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

  // Build container environment
  const containerEnv: string[] = [];
  const envVars: Record<string, string | undefined> = {
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    ...opts.env,
  };
  for (const [k, v] of Object.entries(envVars)) {
    if (v !== undefined) {
      containerEnv.push(`${k}=${v}`);
    }
  }

  const dockerGid = process.env.DOCKER_GID;

  // Ensure the Docker network exists (create if needed so agents work
  // even when the platform is started outside docker-compose)
  const NETWORK_NAME = 'optimushq-net';
  try {
    const nets = await docker.listNetworks({ filters: JSON.stringify({ name: [NETWORK_NAME] }) });
    const exact = nets.find(n => n.Name === NETWORK_NAME);
    if (!exact) {
      await docker.createNetwork({ Name: NETWORK_NAME, Driver: 'bridge' });
      console.log(`[DOCKER-SPAWN] Created network ${NETWORK_NAME}`);
    }
  } catch (err: any) {
    console.error(`[DOCKER-SPAWN] Network check/create failed:`, err.message);
  }

  console.log(`[DOCKER-SPAWN] Creating container ${containerName} from image ${image}`);
  console.log(`[DOCKER-SPAWN] Binds: ${binds.join(', ')}`);
  console.log(`[DOCKER-SPAWN] Cmd: claude ${args.map(a => a.length > 80 ? a.substring(0, 80) + '...' : a).join(' ')}`);

  // Remove any leftover container with the same name
  try {
    const old = docker.getContainer(containerName);
    await old.stop({ t: 2 }).catch(() => {});
    await old.remove({ force: true }).catch(() => {});
  } catch {
    // Container doesn't exist — expected
  }

  const container = await docker.createContainer({
    name: containerName,
    Image: image,
    Cmd: ['claude', ...args],
    WorkingDir: '/workspace',
    Env: containerEnv,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: false,
    Tty: false,
    NetworkingConfig: {
      EndpointsConfig: {
        'optimushq-net': {},
      },
    },
    HostConfig: {
      Binds: binds,
      AutoRemove: true,
      GroupAdd: dockerGid ? [dockerGid] : [],
      NetworkMode: 'optimushq-net',
    },
  });

  console.log(`[DOCKER-SPAWN] Container created: ${container.id}`);

  // Attach to stdout/stderr before starting
  const attachStream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });

  const stdout = new PassThrough();
  const stderr = new PassThrough();

  // Docker multiplexes stdout and stderr into a single stream.
  // demuxStream splits them into separate streams.
  docker.modem.demuxStream(attachStream, stdout, stderr);

  // Start the container
  await container.start();
  console.log(`[DOCKER-SPAWN] Container started: ${container.id}`);

  // Handle container exit — close the streams so the caller knows we're done
  container.wait().then((result) => {
    console.log(`[DOCKER-SPAWN] Container ${containerName} exited with code ${result.StatusCode}`);
    stdout.end();
    stderr.end();
  }).catch((err) => {
    console.error(`[DOCKER-SPAWN] Container wait error:`, err.message);
    stdout.end();
    stderr.end();
  });

  return {
    stdout,
    stderr,
    containerId: container.id,
    kill: async () => {
      try {
        console.log(`[DOCKER-SPAWN] Stopping container ${containerName}`);
        await container.stop({ t: 5 });
      } catch (err: any) {
        // Container may already be stopped/removed (AutoRemove)
        if (!err.message?.includes('not running') && !err.message?.includes('No such container')) {
          console.error(`[DOCKER-SPAWN] Stop error:`, err.message);
        }
      }
    },
  };
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
