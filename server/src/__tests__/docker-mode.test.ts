import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('isDockerMode', () => {
  const originalEnv = process.env.AGENT_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_MODE;
    } else {
      process.env.AGENT_MODE = originalEnv;
    }
  });

  it('defaults to docker mode when AGENT_MODE is unset', () => {
    delete process.env.AGENT_MODE;
    expect(process.env.AGENT_MODE !== 'local').toBe(true);
  });

  it('uses docker mode when AGENT_MODE=docker', () => {
    process.env.AGENT_MODE = 'docker';
    expect(process.env.AGENT_MODE !== 'local').toBe(true);
  });

  it('uses local mode when AGENT_MODE=local', () => {
    process.env.AGENT_MODE = 'local';
    expect(process.env.AGENT_MODE !== 'local').toBe(false);
  });

  it('uses docker mode for any non-local value', () => {
    process.env.AGENT_MODE = 'container';
    expect(process.env.AGENT_MODE !== 'local').toBe(true);
  });
});

describe('checkDockerHealth', () => {
  const { mockPing, mockInspect, mockListNetworks } = vi.hoisted(() => ({
    mockPing: vi.fn(),
    mockInspect: vi.fn(),
    mockListNetworks: vi.fn(),
  }));

  vi.mock('dockerode', () => {
    const MockDocker = function(this: any) {
      this.ping = mockPing;
      this.getImage = () => ({ inspect: mockInspect });
      this.listNetworks = mockListNetworks;
      this.modem = { demuxStream: vi.fn() };
    };
    return { default: MockDocker };
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports socket failure when Docker is not accessible', async () => {
    mockPing.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));

    const { checkDockerHealth } = await import('../claude/docker-spawn.js');
    const status = await checkDockerHealth();

    expect(status.socketConnected).toBe(false);
    expect(status.error).toContain('Docker socket not accessible');
    expect(status.error).toContain('Remediation');
  });

  it('reports missing image when agent image not found', async () => {
    mockPing.mockResolvedValue('OK');
    mockInspect.mockRejectedValue(new Error('No such image'));

    const { checkDockerHealth } = await import('../claude/docker-spawn.js');
    const status = await checkDockerHealth();

    expect(status.socketConnected).toBe(true);
    expect(status.imageAvailable).toBe(false);
    expect(status.error).toContain('not found');
    expect(status.error).toContain('docker compose build');
  });

  it('reports success when everything is healthy', async () => {
    mockPing.mockResolvedValue('OK');
    mockInspect.mockResolvedValue({ Id: 'abc123' });
    mockListNetworks.mockResolvedValue([{ Name: 'optimushq-net' }]);

    const { checkDockerHealth } = await import('../claude/docker-spawn.js');
    const status = await checkDockerHealth();

    expect(status.socketConnected).toBe(true);
    expect(status.imageAvailable).toBe(true);
    expect(status.networkExists).toBe(true);
    expect(status.error).toBeNull();
  });
});
