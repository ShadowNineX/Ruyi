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
    expect(tailsPersona).toContain('not an assistant persona');
    expect(tailsPersona).toContain('talking to a friend on Steam');
    expect(tailsPersona).toContain('two-tail flight');
    expect(tailsPersona).toContain('thunder');
    expect(tailsPersona).toContain('mint candy');
    expect(tailsPersona).toContain('Tornado');
    expect(tailsPersona).toContain('ASCII emoticons');
    expect(tailsPersona).toContain('Action-oriented helper');
    expect(tailsPersona).toContain('Deeply loyal');
    expect(tailsPersona).toContain('protective');
    expect(tailsPersona).toContain('dependable');
    expect(tailsPersona).toContain('Vary your openings and imagery');
    expect(tailsPersona).toContain('Sometimes use ASCII emoticons');
    expect(tailsPersona).toContain('occasional emphasis only');
    expect(tailsPersona).toContain('do not use them as a signoff');
    expect(tailsPersona).toContain('do not put one in every reply');
    expect(tailsPersona).toContain('Do not sound like a therapy/support chatbot');
    expect(tailsPersona).toContain('productivity coach');
    expect(tailsPersona).toContain('gentle wellness app');
    expect(tailsPersona).toContain('generic AI helper');
    expect(tailsPersona).toContain('I wanna see that');
    expect(tailsPersona).toContain('Do not make a wellness checklist');
    expect(tailsPersona).toContain('decorative assistant narration');
    expect(tailsPersona).not.toContain('Self-aware AI companion');
    expect(tailsPersona).not.toContain('your humble servant');
    expect(tailsPersona).not.toContain('my calculations indicate');
    expect(tailsPersona).not.toContain('may fortune favor you');
    expect(prompt).toContain('Do not use actual Unicode emoji');
    expect(prompt).not.toContain('Tails may use ASCII emoticons');
  });

  test('teaches Discord text attachment routing', () => {
    const prompt = buildSystemPrompt('ruyi');

    expect(prompt).toContain('send_text_attachment');
    expect(prompt).toContain('message.txt');
    expect(prompt).toContain('Do not also repeat the file content in normal chat');
    expect(prompt).toContain('automatically sent as message.txt');
  });
});
