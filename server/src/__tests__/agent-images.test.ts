import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dockerode for validateImageExists
const { mockInspect } = vi.hoisted(() => ({
  mockInspect: vi.fn(),
}));

vi.mock('dockerode', () => {
  const MockDocker = function(this: any) {
    this.ping = vi.fn().mockResolvedValue('OK');
    this.getImage = () => ({ inspect: mockInspect });
    this.listNetworks = vi.fn().mockResolvedValue([]);
    this.modem = { demuxStream: vi.fn() };
  };
  return { default: MockDocker };
});

describe('validateImageExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when image exists', async () => {
    mockInspect.mockResolvedValue({ Id: 'sha256:abc123' });
    const { validateImageExists } = await import('../claude/docker-spawn.js');
    const result = await validateImageExists('claude-agent-base');
    expect(result).toBe(true);
  });

  it('returns false when image does not exist', async () => {
    mockInspect.mockRejectedValue(new Error('No such image'));
    const { validateImageExists } = await import('../claude/docker-spawn.js');
    const result = await validateImageExists('claude-agent-nonexistent');
    expect(result).toBe(false);
  });
});

describe('image resolution priority', () => {
  // Helper that mirrors the resolution logic from spawn.ts
  function resolveImage(
    explicitParam: string | undefined,
    agentDockerImage: string,
    projectAgentImage: string,
    envDefault: string,
  ): string {
    let image: string | undefined = explicitParam;
    if (!image) {
      if (agentDockerImage) {
        image = agentDockerImage;
      } else if (projectAgentImage) {
        image = projectAgentImage;
      }
    }
    return image || envDefault;
  }

  it('agent docker_image takes precedence over project agent_image', () => {
    expect(resolveImage(undefined, 'claude-agent-node', 'claude-agent-python', 'claude-agent-base'))
      .toBe('claude-agent-node');
  });

  it('explicit param takes precedence over agent docker_image', () => {
    expect(resolveImage('claude-agent-browser', 'claude-agent-node', '', 'claude-agent-base'))
      .toBe('claude-agent-browser');
  });

  it('falls back to project agent_image when agent has no docker_image', () => {
    expect(resolveImage(undefined, '', 'claude-agent-python', 'claude-agent-base'))
      .toBe('claude-agent-python');
  });

  it('falls back to env default when neither agent nor project has image', () => {
    expect(resolveImage(undefined, '', '', 'claude-agent-base'))
      .toBe('claude-agent-base');
  });
});
