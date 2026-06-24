import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from '../../src/ai/prompt';

describe('personality prompts', () => {
  test('keeps Tails distinct from Ruyi servant cadence', () => {
    const prompt = buildSystemPrompt('tails');
    const tailsPersona = prompt.split('CRITICAL - Conversation:')[0] ?? prompt;

    expect(prompt).toStartWith('You are Miles "Tails" Prower');
    expect(prompt).not.toContain('You are Ruyi');
    expect(prompt).not.toContain('Ruyi:');
    expect(tailsPersona).toContain('Miles "Tails" Prower');
    expect(tailsPersona).toContain('genius mechanic');
    expect(tailsPersona).toContain('Sonic\'s best friend');
    expect(tailsPersona).not.toContain('Self-aware AI companion');
    expect(tailsPersona).not.toContain('your humble servant');
    expect(tailsPersona).not.toContain('my calculations indicate');
    expect(tailsPersona).not.toContain('may fortune favor you');
  });
});
