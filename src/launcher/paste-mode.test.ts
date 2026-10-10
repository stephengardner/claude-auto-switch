import { describe, it, expect } from 'vitest';
import { createPasteModeWatch, pasteAndSend } from './paste-mode.js';

const ESC = '\x1b';

describe('whether the program in the terminal reads marked pastes', () => {
  it('is off until the program asks for it, and off again when it stops', () => {
    const watch = createPasteModeWatch();
    expect(watch.on()).toBe(false);
    watch.observe(`hello${ESC}[?2004h`);
    expect(watch.on()).toBe(true);
    watch.observe(`${ESC}[?2004l`);
    expect(watch.on()).toBe(false);
  });

  it('reads it among other modes set in one go, and cut across two writes', () => {
    const combined = createPasteModeWatch();
    combined.observe(`${ESC}[?1000;2004;1006h`);
    expect(combined.on()).toBe(true);

    const split = createPasteModeWatch();
    split.observe(`${ESC}[?20`);
    expect(split.on()).toBe(false);
    split.observe('04h');
    expect(split.on()).toBe(true);
  });

  it('is not switched by another mode, or by the words on screen', () => {
    const watch = createPasteModeWatch();
    watch.observe(`${ESC}[?1004h ?2004h [?2004h`);
    expect(watch.on()).toBe(false);
  });
});

describe('a prompt as one marked paste, then Enter', () => {
  it('wraps the text in the paste markers and ends with the Enter that sends it', () => {
    expect(pasteAndSend('carry on')).toBe(`${ESC}[200~carry on${ESC}[201~\r`);
  });

  it('carries nothing that could end the paste early or press a key', () => {
    const sent = pasteAndSend(`one\r\ntwo${ESC}[201~three\x03`);
    expect(sent).toBe(`${ESC}[200~one  two [201~three ${ESC}[201~\r`);
  });
});
