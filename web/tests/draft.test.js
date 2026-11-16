import { describe, expect, it } from 'vitest';
import { extractDraft, extractStatus } from '../src/draft.js';

const RULE = '─'.repeat(84);
const row = (text, dim = false) => [...text].map((ch) => ({ ch, dim }));
const screen = (...lines) => lines.map((line) => (typeof line === 'string' ? row(line) : line));

describe('extractStatus', () => {
  it('says Claude is busy while its spinner line is above the prompt', () => {
    const rows = screen('❯ сделай куб красным', '✽ Honking… (esc to interrupt)', RULE, '>', RULE, '  footer');

    expect(extractStatus(rows)).toEqual({ busy: true, reply: '' });
  });

  it('gives the last answer once Claude is done', () => {
    const rows = screen(
      '● Update(web\\src\\scene\\main.js)',
      '  ⎿  Added 1 line, removed 1 line',
      '● Куб теперь красный, страница приняла',
      '  изменение.',
      '✻ Crunched for 6s · done 2:25 AM',
      RULE,
      '>',
      RULE,
      '  footer',
    );

    expect(extractStatus(rows)).toEqual({ busy: false, reply: 'Куб теперь красный, страница приняла изменение.' });
  });

  it('is quiet when nothing has happened yet', () => {
    expect(extractStatus(screen(' Claude Code v2.1.325', RULE, '>', RULE, '  footer'))).toEqual({ busy: false, reply: '' });
  });

  it('is quiet when there is no prompt box on screen', () => {
    expect(extractStatus(screen('Do you want to proceed?'))).toEqual({ busy: false, reply: '' });
  });
});

describe('extractDraft', () => {
  const at = (x, y) => ({ cursor: { x, y } });

  it('reads the text typed into the Claude Code prompt box, up to the cursor', () => {
    const rows = screen('● Привет', RULE, '❯ добавь пистолет передо мной', RULE, '  ⏵⏵ auto mode on');

    expect(extractDraft(rows, at(29, 2))).toBe('добавь пистолет передо мной');
  });

  it('joins a prompt that wraps over several rows', () => {
    const rows = screen(RULE, '❯ добавь пистолет передо мной и сделай', '  его красным', RULE, '  footer');

    expect(extractDraft(rows, at(13, 2))).toBe('добавь пистолет передо мной и сделай его красным');
  });

  it('ignores the hint Claude Code shows after the cursor in an empty prompt', () => {
    // It is drawn in the same colour as real text; only the cursor tells them apart.
    const rows = screen(RULE, '❯ Try "write a test for <filepath>"', RULE, '  footer');

    expect(extractDraft(rows, at(2, 1))).toBe('');
  });

  it('includes the words being recognised right now, without the level bar', () => {
    const rows = screen(RULE, '❯ добавь пистолет▆', RULE, '  footer');

    expect(extractDraft(rows, at(18, 1))).toBe('добавь пистолет');
  });

  it('accepts a rule line with a title in it', () => {
    const titled = `${'─'.repeat(50)} Голосовой ввод Oculus Quest 3S ─`;

    expect(extractDraft(screen(titled, '> привет', RULE, '  footer'), at(8, 1))).toBe('привет');
  });

  it('without a cursor in the box it still drops the well-known hint', () => {
    const rows = screen(RULE, '❯ Try "write a test for <filepath>"', RULE, '  footer');

    expect(extractDraft(rows)).toBe('');
    expect(extractDraft(screen(RULE, '❯ привет', RULE, '  footer'), at(0, 3))).toBe('привет');
  });

  it('is empty when there is no prompt box on screen (a dialog, start-up)', () => {
    expect(extractDraft(screen('Do you want to proceed?', '❯ 1. Yes', '  2. No'), at(0, 1))).toBe('');
  });
});
