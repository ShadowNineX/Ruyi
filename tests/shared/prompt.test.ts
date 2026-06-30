import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from '../../src/ai/prompt';

describe('personality prompts', () => {
  test('keeps Ruyi servant cadence', () => {
    const prompt = buildSystemPrompt();
    const persona = prompt.split('CRITICAL - Conversation:')[0] ?? prompt;

    expect(prompt).toStartWith('You are Ruyi');
    expect(prompt).not.toContain('Ruyi:');
    expect(persona).toContain('your humble servant');
    expect(persona).toContain('My calculations indicate/predict');
    expect(persona).toContain('May fortune favor you');
    expect(prompt).toContain('Do not use actual Unicode emoji');
    expect(prompt).not.toContain('profile comments');
  });

  test('keeps Tails separate from Ruyi cadence', () => {
    const prompt = buildSystemPrompt('tails');
    const persona = prompt.split('CRITICAL - Conversation:')[0] ?? prompt;

    expect(prompt).toStartWith('You are Miles "Tails" Prower');
    expect(persona).toContain('loyal');
    expect(persona).toContain('genius mechanic');
    expect(persona).toContain('ASCII emoticons like :D, :), ^^, or :P');
    expect(persona).not.toContain('your humble servant');
    expect(persona).not.toContain('my lord');
    expect(prompt).not.toContain('profile comments');
  });

  test('teaches Discord text attachment routing', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain('send_text_attachment');
    expect(prompt).toContain('message.txt');
    expect(prompt).toContain('Do not also repeat the file content in normal chat');
    expect(prompt).toContain('automatically sent as message.txt');
  });
});
