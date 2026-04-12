import { describe, expect, it } from 'vitest';
import { formatEnvironmentHelp, getEnvVarStatus } from '../../src/help/environment.js';

describe('getEnvVarStatus', () => {
  it('returns missing when the variable is absent', () => {
    expect(getEnvVarStatus('OPENAI_API_KEY', {})).toBe('missing');
  });

  it('returns empty when the variable is set to an empty string', () => {
    expect(getEnvVarStatus('OPENAI_API_KEY', { OPENAI_API_KEY: '' })).toBe('empty');
  });

  it('returns set when the variable has a value', () => {
    expect(getEnvVarStatus('OPENAI_API_KEY', { OPENAI_API_KEY: 'token' })).toBe('set');
  });
});

describe('formatEnvironmentHelp', () => {
  it('renders current status and descriptions for each supported variable', () => {
    const help = formatEnvironmentHelp({
      OPENAI_API_KEY: 'token',
      GITHUB_TOKEN: '',
      RCL_DEBUG: '1',
    });

    expect(help).toContain('Environment Variables:');
    expect(help).toContain('OPENAI_API_KEY');
    expect(help).toContain('[set]');
    expect(help).toContain('GITHUB_TOKEN');
    expect(help).toContain('[empty]');
    expect(help).toContain('RCL_DEBUG');
    expect(help).toContain('Set to print full error stack traces.');
    expect(help).toContain('ANTHROPIC_API_KEY');
    expect(help).toContain('[missing]');
  });
});
